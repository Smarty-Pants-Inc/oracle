import CDP from "chrome-remote-interface";
import { createHash } from "node:crypto";
import type { SessionMetadata, BrowserHarvestState } from "../sessionStore.js";
import {
  ANSWER_SELECTORS,
  ASSISTANT_ROLE_SELECTOR,
  INPUT_SELECTORS,
  MODEL_BUTTON_SELECTOR,
  SEND_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTOR,
} from "./constants.js";
import { captureAssistantMarkdown, readAssistantSnapshot } from "./actions/assistantResponse.js";
import { buildConversationTurnListExpression } from "./conversationTurns.js";
import { extractStableConversationIdFromUrl } from "./conversationUrl.js";
import { delay } from "./utils.js";
import {
  closeTab,
  connectToRemoteChromeTarget,
  listRemoteChromeTargets,
  type RemoteChromeConnection,
} from "./chromeLifecycle.js";
import { resolveRemoteChromeBrowserIdentity } from "./profileState.js";
import { readChatGptAccountDigest } from "./pageActions.js";
import type { ChromeClient } from "./types.js";

export const DEFAULT_REMOTE_CHROME_HOST = "127.0.0.1";
export const DEFAULT_REMOTE_CHROME_PORT = 9222;

const LOGIN_CTA_PATTERN =
  /\b(log in|login|sign up|sign in|continue with google|continue with microsoft)\b/i;
const CHATGPT_HOSTS: Record<string, true> = {
  "chatgpt.com": true,
  "chat.openai.com": true,
};
const ABSOLUTE_URL_AUTHORITY_PATTERN = /^[a-z][a-z\d+.-]*:\/\/([^/?#\\]*)/iu;

class ChatGptOriginError extends Error {}
export interface ChromeTarget {
  id?: string;
  targetId?: string;
  type?: string;
  title?: string;
  url?: string;
}

interface HostPort {
  host?: string;
  port?: number;
  browserWSEndpoint?: string;
  browserId?: string;
  accountDigest?: string;
}

export interface ChatGptTabSummary {
  host?: string;
  port?: number;
  targetId: string;
  title: string;
  url: string;
  currentModelLabel: string;
  stopExists: boolean;
  sendExists: boolean;
  promptReady: boolean;
  loginButtonExists: boolean;
  authenticated: boolean;
  assistantCount: number;
  lastAssistantText: string;
  assistantFollowsLatestUser?: boolean;
  lastAssistantTurnIndex?: number;
  lastUserTurnIndex?: number;
  lastAssistantSnippet: string;
  lastUserText: string;
  lastUserSnippet: string;
  focused: boolean;
  visibilityState: string;
  conversationId?: string;
  fingerprint: string;
  state: BrowserHarvestState;
  error?: string;
  lastAssistantMarkdown: string | null;
  lastAssistantMessageId?: string;
  lastAssistantTurnId?: string;
}

interface ResolveChatGptTabOptions extends HostPort {
  ref?: string;
  closeTargetOnDispose?: boolean;
}

interface InspectChatGptTabOptions extends HostPort {
  target: ChromeTarget;
  expectedConversationId?: string;
}

interface HarvestChatGptTabOptions extends ResolveChatGptTabOptions {
  target?: ChromeTarget;
  expectedConversationId?: string;
  stallWindowMs?: number;
}

const noopLogger = Object.assign((_message: string) => {}, {}) as ((message: string) => void) & {
  verbose?: boolean;
};

function trimToSnippet(text: string, max = 140): string {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function normalizeHostPort(input: HostPort = {}): { host: string; port: number } {
  return {
    host: input.host ?? DEFAULT_REMOTE_CHROME_HOST,
    port: input.port ?? DEFAULT_REMOTE_CHROME_PORT,
  };
}

async function refreshBoundBrowserEndpoint(options: HostPort): Promise<string | undefined> {
  const expectedBrowserId = options.browserId?.trim();
  const expectedAccountDigest = options.accountDigest?.trim();
  if (!expectedBrowserId && !expectedAccountDigest) return options.browserWSEndpoint;
  if (expectedAccountDigest && !/^[a-f0-9]{64}$/.test(expectedAccountDigest)) {
    throw new Error("Stored ChatGPT account identity is invalid.");
  }
  if (!expectedBrowserId) return options.browserWSEndpoint;
  const { host, port } = normalizeHostPort(options);
  const liveIdentity = await resolveRemoteChromeBrowserIdentity({ host, port });
  if (liveIdentity.browserId !== expectedBrowserId) {
    throw new Error("Remote Chrome browser identity changed before live tab inspection.");
  }
  return liveIdentity.browserWSEndpoint;
}

function normalizeUrl(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeTitle(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTargetFingerprint(
  summary: Pick<ChatGptTabSummary, "targetId" | "url" | "lastAssistantText">,
): string {
  return createHash("sha1")
    .update(`${summary.targetId ?? ""}|${summary.url ?? ""}|${summary.lastAssistantText ?? ""}`)
    .digest("hex");
}

function parseChatGptUrl(value: unknown): URL | null {
  const raw = normalizeUrl(value);
  const authority = ABSOLUTE_URL_AUTHORITY_PATTERN.exec(raw)?.[1];
  if (!authority) return null;
  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !Object.hasOwn(CHATGPT_HOSTS, hostname) ||
      authority.toLowerCase() !== hostname
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function isChatGptUrl(url: string): boolean {
  return parseChatGptUrl(url) !== null;
}

function requireChatGptUrl(url: string, action: string): URL {
  const parsed = parseChatGptUrl(url);
  if (!parsed) {
    throw new ChatGptOriginError(`ChatGPT tab left an allowed HTTPS origin before ${action}.`);
  }
  return parsed;
}

export async function assertChatGptTabOrigin(
  Runtime: ChromeClient["Runtime"],
  action: string,
): Promise<string> {
  const evaluation = await Runtime.evaluate({
    expression:
      'typeof location === "object" && typeof location.href === "string" ? location.href : ""',
    returnByValue: true,
  });
  const url = normalizeUrl(evaluation.result?.value);
  requireChatGptUrl(url, action);
  return url;
}

function isChatGptConversationUrl(url: string): boolean {
  const parsed = parseChatGptUrl(url);
  return parsed ? /\/c\//.test(parsed.pathname) : false;
}

function isChatGptTarget(target: ChromeTarget): boolean {
  return Boolean(target && target.type === "page" && isChatGptUrl(target.url ?? ""));
}

function extractTargetId(target: ChromeTarget | undefined | null): string | null {
  return target?.targetId ?? target?.id ?? null;
}

export function expectedConversationIdForRef(
  ref: string | undefined,
  selected?: { id?: string; targetId?: string; url?: string; conversationId?: string },
): string | undefined {
  const refConversationId = extractConversationIdFromUrl(String(ref ?? "").trim());
  if (refConversationId) return refConversationId;
  return extractConversationIdFromUrl(selected?.url ?? "") ?? selected?.conversationId;
}

export function assertExpectedConversationId(
  expectedConversationId: string | undefined,
  observedUrl: string,
  action: string,
): void {
  if (!expectedConversationId) return;
  const observedConversationId = extractConversationIdFromUrl(observedUrl);
  if (observedConversationId !== expectedConversationId) {
    throw new Error(`ChatGPT conversation changed before ${action}.`);
  }
}

function escapeLiteral(value: string): string {
  return JSON.stringify(value);
}

function buildTabInspectionExpression(expectedConversationId?: string): string {
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const sendSelectorsLiteral = JSON.stringify(SEND_BUTTON_SELECTORS);
  const answerSelectorsLiteral = JSON.stringify(ANSWER_SELECTORS);
  const assistantRoleLiteral = escapeLiteral(ASSISTANT_ROLE_SELECTOR);
  const modelButtonSelectorLiteral = escapeLiteral(MODEL_BUTTON_SELECTOR);
  const stopSelectorLiteral = escapeLiteral(STOP_BUTTON_SELECTOR);
  const expectedConversationLiteral =
    typeof expectedConversationId === "string" && expectedConversationId.trim().length > 0
      ? JSON.stringify(expectedConversationId.trim())
      : "null";
  return `(() => {
      const INPUT_SELECTORS = ${inputSelectorsLiteral};
      const SEND_SELECTORS = ${sendSelectorsLiteral};
      const ANSWER_SELECTORS = ${answerSelectorsLiteral};
      const ASSISTANT_ROLE_SELECTOR = ${assistantRoleLiteral};
      const MODEL_BUTTON_SELECTOR = ${modelButtonSelectorLiteral};
      const STOP_BUTTON_SELECTOR = ${stopSelectorLiteral};
      const LOGIN_CTA = ${LOGIN_CTA_PATTERN.toString()};
      const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const EXPECTED_CONVERSATION_ID = ${expectedConversationLiteral};
      const currentHref = typeof location === 'object' && location.href ? location.href : '';
      const currentConversationId = currentHref.match(/\\/c\\/([a-zA-Z0-9_-]+)/)?.[1] ?? null;
      if (EXPECTED_CONVERSATION_ID && currentConversationId !== EXPECTED_CONVERSATION_ID) {
        return { url: currentHref, scopeMismatch: true };
      }
      const isVisible = (node) => {
        if (!(node instanceof Element)) return false;
        const style = window.getComputedStyle(node);
        if (!style) return false;
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const firstVisible = (selectors) => {
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (node && isVisible(node)) return node;
        }
        return null;
      };
      const loginButtonExists = Array.from(document.querySelectorAll('button,a,[role="button"]')).some((node) => {
        const label = normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title'));
        return LOGIN_CTA.test(label);
      });
      const stopButton = document.querySelector(STOP_BUTTON_SELECTOR);
      const stopExists = Boolean(stopButton && isVisible(stopButton));
      const sendButton = firstVisible(SEND_SELECTORS);
      const sendExists = Boolean(sendButton);
      const promptNode = firstVisible(INPUT_SELECTORS);
      const promptReady = Boolean(promptNode);
      const turns = ${buildConversationTurnListExpression()};
      const assistantTurns = turns.filter((turn) => {
        const role = normalize(turn.getAttribute('data-message-author-role') || turn.getAttribute('data-turn')).toLowerCase();
        if (role === 'assistant') return true;
        return Boolean(turn.querySelector(ASSISTANT_ROLE_SELECTOR));
      });
      const fallbackUserTurns = Array.from(
        document.querySelectorAll('[data-message-author-role="user"], [data-turn="user"]'),
      );
      const userTurns = turns.filter((turn) => {
        const role = normalize(turn.getAttribute('data-message-author-role') || turn.getAttribute('data-turn')).toLowerCase();
        if (role === 'user') return true;
        return Boolean(
          turn.querySelector('[data-message-author-role="user"], [data-turn="user"]'),
        );
      });
      const answerNode = ANSWER_SELECTORS
        .map((selector) => document.querySelectorAll(selector))
        .find((matches) => matches && matches.length > 0);
      const currentModelButton = document.querySelector(MODEL_BUTTON_SELECTOR);
      const hasProPill = Boolean(document.querySelector('button.__composer-pill, button[aria-label="Pro, click to remove"]'));
      let currentModelLabel = normalize(currentModelButton?.textContent || currentModelButton?.getAttribute?.('aria-label') || '');
      if (currentModelLabel === 'ChatGPT' && hasProPill) {
        currentModelLabel = 'ChatGPT + Pro';
      }
      const rawAnswerNodes = Array.from(answerNode || []);
      const userCandidates = Array.from(new Set([...userTurns, ...fallbackUserTurns]));
      const lastUserTurn = userCandidates.reduce((latest, candidate) => {
        if (!latest) return candidate;
        return latest.compareDocumentPosition(candidate) & 4 ? candidate : latest;
      }, null);
      const lastUserContainer = lastUserTurn
        ? turns.find((turn) => turn === lastUserTurn || turn.contains?.(lastUserTurn))
        : null;
      const answerNodes = rawAnswerNodes.filter(
        (node) =>
          !lastUserTurn ||
          (node !== lastUserTurn &&
            !lastUserTurn.contains?.(node) &&
            !node.contains?.(lastUserTurn)),
      );
      const answerTexts = answerNodes.map((node) => normalize(node.textContent)).filter(Boolean);
      const assistantCandidates = Array.from(new Set([...assistantTurns, ...answerNodes]));
      const lastAssistantNode = assistantCandidates.reduce((latest, candidate) => {
        if (!latest) return candidate;
        return latest.compareDocumentPosition(candidate) & 4 ? candidate : latest;
      }, null);
      const lastAssistantContainer = lastAssistantNode
        ? turns.find((turn) => turn === lastAssistantNode || turn.contains?.(lastAssistantNode))
        : null;
      const assistantFollowsLatestUser = Boolean(
        lastAssistantNode &&
        lastUserTurn &&
        lastAssistantNode !== lastUserTurn &&
        (lastUserTurn.compareDocumentPosition(lastAssistantNode) & 4),
      );
      const lastAssistantTurnIndex = lastAssistantContainer
        ? turns.indexOf(lastAssistantContainer)
        : -1;
      const lastUserTurnIndex = lastUserContainer ? turns.indexOf(lastUserContainer) : -1;
      const assistantOwners = assistantCandidates.map(
        (node) => turns.find((turn) => turn === node || turn.contains?.(node)) || node,
      );
      const assistantCount = new Set(assistantOwners).size;
      const lastAssistantText = normalize(lastAssistantNode?.textContent);
      const lastUserText = normalize(lastUserTurn?.textContent);
      const authenticated = !loginButtonExists && (promptReady || sendExists || stopExists || assistantCount > 0);
      return {
        title: normalize(document.title),
        url: location.href,
        currentModelLabel,
        stopExists,
        sendExists,
        promptReady,
        loginButtonExists,
        authenticated,
        assistantCount,
        lastAssistantText,
        assistantFollowsLatestUser,
        lastAssistantTurnIndex,
        lastUserTurnIndex,
        lastUserText,
        visibilityState: document.visibilityState,
        focused: Boolean(document.hasFocus?.()),
      };
    })()`;
}

export function buildTabInspectionExpressionForTest(expectedConversationId?: string): string {
  return buildTabInspectionExpression(expectedConversationId);
}

export async function listChatGptTargets(options: HostPort = {}): Promise<ChromeTarget[]> {
  const { host, port } = normalizeHostPort(options);
  const targets = (await CDP.List({ host, port })) as ChromeTarget[];
  return targets.filter(isChatGptTarget);
}

export async function openChatGptTarget(
  options: HostPort & {
    url?: string;
    /** Retained for source compatibility; the temporary handoff is always awaited. */
    returnTargetBeforeClose?: boolean;
    onHandoffError?: (error: unknown) => void;
    onTargetCreated?: (targetId: string) => void;
  } = {},
): Promise<string> {
  const { host, port } = normalizeHostPort(options);
  const url = options.url ?? "https://chatgpt.com/";
  requireChatGptUrl(url, "opening a ChatGPT tab");
  const reportHandoffError = (error: unknown): void => {
    try {
      options.onHandoffError?.(error);
    } catch {
      // Handoff reporting must not replace the original failure.
    }
  };
  const closeAfterHandoffFailure = async (
    targetId: string,
    handoffError: unknown,
  ): Promise<never> => {
    try {
      const closed = await closeTab(port, targetId, noopLogger, host);
      if (closed) {
        reportHandoffError(handoffError);
        throw handoffError;
      }
      throw new Error("Remote Chrome target cleanup was not confirmed.");
    } catch (cleanupError) {
      const failure =
        cleanupError === handoffError
          ? handoffError
          : new AggregateError(
              [handoffError, cleanupError],
              "Remote Chrome target handoff and cleanup failed.",
            );
      reportHandoffError(failure);
      throw failure;
    }
  };
  if (options.browserWSEndpoint) {
    let createdTargetId: string | undefined;
    let connection: RemoteChromeConnection;
    try {
      connection = await connectToRemoteChromeTarget(host, port, noopLogger, {
        browserWSEndpoint: options.browserWSEndpoint,
        targetUrl: url,
        closeTargetOnDispose: false,
        onTargetCreated: (targetId) => {
          createdTargetId = targetId;
          options.onTargetCreated?.(targetId);
        },
      });
    } catch (error) {
      if (createdTargetId) {
        await closeAfterHandoffFailure(createdTargetId, error);
      }
      reportHandoffError(error);
      throw error;
    }
    const targetId = connection.targetId ?? createdTargetId;
    if (!targetId) {
      try {
        await connection.close();
      } catch (error) {
        reportHandoffError(error);
      }
      throw new Error("Remote Chrome did not return a target id.");
    }
    if (!createdTargetId) {
      createdTargetId = targetId;
      options.onTargetCreated?.(targetId);
    }
    try {
      await connection.close();
    } catch (closeError) {
      await closeAfterHandoffFailure(targetId, closeError);
    }
    return targetId;
  }
  const target = await CDP.New({ host, port, url });
  const targetId = target.id;
  if (!targetId) throw new Error("Remote Chrome did not return a target id.");
  try {
    options.onTargetCreated?.(targetId);
  } catch (error) {
    await closeAfterHandoffFailure(targetId, error);
  }
  return targetId;
}

async function connectToTarget(
  host: string,
  port: number,
  targetId: string,
  browserWSEndpoint?: string,
) {
  if (browserWSEndpoint) {
    const connection = await connectToRemoteChromeTarget(host, port, noopLogger, {
      browserWSEndpoint,
      targetId,
      closeTargetOnDispose: false,
    });
    Object.defineProperty(connection.client, "close", {
      configurable: true,
      value: connection.close,
    });
    return connection.client;
  }
  const client = await CDP({ host, port, target: targetId });
  const { Runtime, DOM } = client;
  if (Runtime?.enable) {
    await Runtime.enable();
  }
  if (DOM?.enable) {
    await DOM.enable();
  }
  return client;
}

export async function inspectChatGptTab(
  options: InspectChatGptTabOptions,
): Promise<ChatGptTabSummary> {
  const { host, port } = normalizeHostPort(options);
  const target = options.target;
  requireChatGptUrl(target.url ?? "", "live tab selection");
  const targetId = extractTargetId(target);
  if (!targetId) {
    throw new Error("inspectChatGptTab requires a target with targetId.");
  }

  const client = await connectToTarget(host, port, targetId, options.browserWSEndpoint);
  try {
    const { Runtime } = client;
    const initialUrl = await assertChatGptTabOrigin(Runtime, "live tab inspection");
    assertExpectedConversationId(options.expectedConversationId, initialUrl, "live tab inspection");
    const expectedAccountDigest = options.accountDigest?.trim();
    if (expectedAccountDigest) {
      const observedAccountDigest = await readChatGptAccountDigest(Runtime);
      if (observedAccountDigest !== expectedAccountDigest) {
        throw new Error("Remote Chrome account identity changed before live tab inspection.");
      }
    }
    const evaluation = await Runtime.evaluate({
      expression: buildTabInspectionExpression(options.expectedConversationId),
      returnByValue: true,
      awaitPromise: true,
    });
    const info = (evaluation.result?.value ?? {}) as {
      title?: string;
      url?: string;
      currentModelLabel?: string;
      stopExists?: boolean;
      sendExists?: boolean;
      promptReady?: boolean;
      loginButtonExists?: boolean;
      authenticated?: boolean;
      assistantCount?: number;
      lastAssistantText?: string;
      assistantFollowsLatestUser?: boolean;
      lastAssistantTurnIndex?: number;
      lastUserTurnIndex?: number;
      lastUserText?: string;
      visibilityState?: string;
      focused?: boolean;
      scopeMismatch?: boolean;
    };
    const inspectedUrl = normalizeUrl(info.url ?? target.url ?? "");
    requireChatGptUrl(inspectedUrl, "live tab inspection");
    assertExpectedConversationId(
      options.expectedConversationId,
      inspectedUrl,
      "live tab inspection evaluation",
    );
    const snapshotUrl = await assertChatGptTabOrigin(Runtime, "live tab inspection snapshot");
    assertExpectedConversationId(
      options.expectedConversationId,
      snapshotUrl,
      "live tab inspection snapshot",
    );
    const snapshot = await readAssistantSnapshot(
      Runtime,
      undefined,
      options.expectedConversationId,
    ).catch(() => null);
    const finalUrl = await assertChatGptTabOrigin(Runtime, "live tab inspection completion");
    assertExpectedConversationId(
      options.expectedConversationId,
      finalUrl,
      "live tab inspection completion",
    );
    const inspectedAssistantTurnIndex =
      typeof info.lastAssistantTurnIndex === "number" && info.lastAssistantTurnIndex >= 0
        ? info.lastAssistantTurnIndex
        : undefined;
    const normalizedSnapshotText = normalizeTitle(snapshot?.text ?? "").toLowerCase();
    const normalizedInspectedText = normalizeTitle(info.lastAssistantText ?? "").toLowerCase();
    const snapshotMatchesInspectedTurn =
      (typeof snapshot?.turnIndex === "number" &&
        snapshot.turnIndex === inspectedAssistantTurnIndex) ||
      (snapshot?.turnIndex == null &&
        inspectedAssistantTurnIndex === undefined &&
        normalizedSnapshotText.length > 0 &&
        normalizedSnapshotText === normalizedInspectedText);
    const lastAssistantText =
      snapshotMatchesInspectedTurn &&
      typeof snapshot?.text === "string" &&
      snapshot.text.trim().length > 0
        ? snapshot.text.trim()
        : String(info.lastAssistantText ?? "").trim();
    const lastUserText = String(info.lastUserText ?? "").trim();
    const summary: ChatGptTabSummary = {
      host,
      port,
      targetId,
      title: normalizeTitle(info.title ?? target.title ?? ""),
      url: finalUrl,
      currentModelLabel: normalizeTitle(info.currentModelLabel ?? ""),
      stopExists: Boolean(info.stopExists),
      sendExists: Boolean(info.sendExists),
      promptReady: Boolean(info.promptReady),
      loginButtonExists: Boolean(info.loginButtonExists),
      authenticated: Boolean(info.authenticated),
      assistantCount: Number.isFinite(info.assistantCount) ? Number(info.assistantCount) : 0,
      lastAssistantText,
      assistantFollowsLatestUser: Boolean(info.assistantFollowsLatestUser),
      lastAssistantTurnIndex: inspectedAssistantTurnIndex,
      lastUserTurnIndex:
        typeof info.lastUserTurnIndex === "number" && info.lastUserTurnIndex >= 0
          ? info.lastUserTurnIndex
          : undefined,
      lastAssistantSnippet: trimToSnippet(lastAssistantText),
      lastUserText,
      lastUserSnippet: trimToSnippet(lastUserText),
      focused: Boolean(info.focused),
      visibilityState: typeof info.visibilityState === "string" ? info.visibilityState : "",
      conversationId: extractConversationIdFromUrl(finalUrl),
      fingerprint: "",
      state: "detached",
      lastAssistantMarkdown: null,
      lastAssistantMessageId:
        snapshotMatchesInspectedTurn && typeof snapshot?.messageId === "string"
          ? snapshot.messageId
          : undefined,
      lastAssistantTurnId:
        snapshotMatchesInspectedTurn && typeof snapshot?.turnId === "string"
          ? snapshot.turnId
          : undefined,
    };
    summary.state = classifyTabState(summary);
    summary.fingerprint = buildTargetFingerprint(summary);
    return summary;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function classifyTabState(
  summary: Pick<
    ChatGptTabSummary,
    "authenticated" | "stopExists" | "sendExists" | "promptReady" | "assistantCount"
  >,
): BrowserHarvestState {
  if (!summary?.authenticated) {
    return "detached";
  }
  if (summary.stopExists) {
    return "running";
  }
  if (summary.sendExists || summary.promptReady || summary.assistantCount > 0) {
    return "completed";
  }
  return "detached";
}

export async function collectChatGptTabs(options: HostPort = {}): Promise<ChatGptTabSummary[]> {
  const { host, port } = normalizeHostPort(options);
  const browserWSEndpoint = await refreshBoundBrowserEndpoint(options);
  const targets = browserWSEndpoint
    ? ((await listRemoteChromeTargets({ host, port, browserWSEndpoint })) as ChromeTarget[]).filter(
        isChatGptTarget,
      )
    : await listChatGptTargets({ host, port });
  return collectChatGptTabsFromTargets(
    host,
    port,
    targets,
    browserWSEndpoint,
    options.accountDigest,
  );
}

function resolveChatGptTabFromSummaries(
  summaries: ChatGptTabSummary[],
  ref?: string,
): ChatGptTabSummary {
  const chatGptSummaries = Array.isArray(summaries)
    ? summaries.filter((summary) => isChatGptUrl(summary.url))
    : [];
  if (chatGptSummaries.length === 0) {
    throw new Error("No live ChatGPT tabs found on the configured Chrome DevTools endpoint.");
  }
  const trimmedRef = String(ref ?? "").trim();
  if (!trimmedRef || trimmedRef.toLowerCase() === "current") {
    return chatGptSummaries[0] as ChatGptTabSummary;
  }
  const exactId = chatGptSummaries.find((tab) => tab.targetId === trimmedRef);
  if (exactId) {
    return exactId;
  }
  const exactUrl = chatGptSummaries.find((tab) => tab.url === trimmedRef);
  if (exactUrl) {
    return exactUrl;
  }
  const refConversationId = extractConversationIdFromUrl(trimmedRef) ?? trimmedRef;
  const exactConversation = chatGptSummaries.find(
    (tab) => tab.conversationId === refConversationId,
  );
  if (exactConversation) {
    return exactConversation;
  }
  const lower = trimmedRef.toLowerCase();
  const titleMatches = chatGptSummaries.filter((tab) => tab.title.toLowerCase().includes(lower));
  if (titleMatches.length === 1) {
    return titleMatches[0] as ChatGptTabSummary;
  }
  if (titleMatches.length > 1) {
    throw new Error(
      'Multiple ChatGPT tabs match the requested reference. Use "oracle-tabs" or "oracle status --browser-tabs" to choose a unique target.',
    );
  }
  throw new Error(
    'No ChatGPT tab matched the requested reference. Use "oracle-tabs" or "oracle status --browser-tabs" to inspect live targets.',
  );
}

export function resolveChatGptTabFromSummariesForTest(
  summaries: ChatGptTabSummary[],
  ref?: string,
): ChatGptTabSummary {
  return resolveChatGptTabFromSummaries(summaries, ref);
}

function resolveExactChatGptTarget(targets: ChromeTarget[], ref?: string): ChromeTarget | null {
  const chatGptTargets = targets.filter(isChatGptTarget);
  const trimmedRef = String(ref ?? "").trim();
  if (!trimmedRef || trimmedRef.toLowerCase() === "current") {
    return null;
  }
  const refConversationId = extractConversationIdFromUrl(trimmedRef) ?? trimmedRef;
  return (
    chatGptTargets.find((target) => extractTargetId(target) === trimmedRef) ??
    chatGptTargets.find((target) => normalizeUrl(target.url ?? "") === trimmedRef) ??
    chatGptTargets.find(
      (target) => extractConversationIdFromUrl(target.url ?? "") === refConversationId,
    ) ??
    null
  );
}

export function resolveExactChatGptTargetForTest(
  targets: ChromeTarget[],
  ref?: string,
): ChromeTarget | null {
  return resolveExactChatGptTarget(targets, ref);
}

function summaryFromTarget(host: string, port: number, target: ChromeTarget): ChatGptTabSummary {
  const targetId = extractTargetId(target) ?? "";
  const url = normalizeUrl(target.url ?? "");
  requireChatGptUrl(url, "live tab summary creation");
  return {
    host,
    port,
    targetId,
    title: normalizeTitle(target.title ?? ""),
    url,
    currentModelLabel: "",
    stopExists: false,
    sendExists: false,
    promptReady: false,
    loginButtonExists: false,
    authenticated: false,
    assistantCount: 0,
    lastAssistantText: "",
    lastAssistantSnippet: "",
    lastUserText: "",
    lastUserSnippet: "",
    focused: false,
    visibilityState: "",
    conversationId: extractConversationIdFromUrl(url),
    fingerprint: buildTargetFingerprint({ targetId, url, lastAssistantText: "" }),
    state: "detached",
    lastAssistantMarkdown: null,
  };
}

export function summaryFromTargetForTest(
  host: string,
  port: number,
  target: ChromeTarget,
): ChatGptTabSummary {
  return summaryFromTarget(host, port, target);
}

async function collectChatGptTabsFromTargets(
  host: string,
  port: number,
  targets: ChromeTarget[],
  browserWSEndpoint?: string,
  accountDigest?: string,
): Promise<ChatGptTabSummary[]> {
  const summaries: ChatGptTabSummary[] = [];
  for (const target of targets.filter(isChatGptTarget)) {
    try {
      const summary = await inspectChatGptTab({
        host,
        port,
        target,
        browserWSEndpoint,
        accountDigest,
      });
      summaries.push(summary);
    } catch (error) {
      if (error instanceof ChatGptOriginError) continue;
      if (accountDigest) throw error;

      summaries.push({
        host,
        port,
        targetId: extractTargetId(target) ?? "",
        title: normalizeTitle(target.title ?? ""),
        url: normalizeUrl(target.url ?? ""),
        currentModelLabel: "",
        stopExists: false,
        sendExists: false,
        promptReady: false,
        loginButtonExists: false,
        authenticated: false,
        assistantCount: 0,
        lastAssistantText: "",
        lastAssistantSnippet: "",
        lastUserText: "",
        lastUserSnippet: "",
        focused: false,
        visibilityState: "",
        conversationId: extractConversationIdFromUrl(target.url ?? ""),
        fingerprint: "",
        state: "detached",
        error: error instanceof Error ? error.message : String(error),
        lastAssistantMarkdown: null,
      });
    }
  }
  return summaries.sort((left, right) => {
    const leftScore = (left.focused ? 100 : 0) + (isChatGptConversationUrl(left.url) ? 10 : 0);
    const rightScore = (right.focused ? 100 : 0) + (isChatGptConversationUrl(right.url) ? 10 : 0);
    return rightScore - leftScore;
  });
}

export async function resolveChatGptTab(
  options: ResolveChatGptTabOptions = {},
): Promise<ChatGptTabSummary> {
  const { host, port } = normalizeHostPort(options);
  const browserWSEndpoint = await refreshBoundBrowserEndpoint(options);
  const targets = browserWSEndpoint
    ? ((await listRemoteChromeTargets({ host, port, browserWSEndpoint })) as ChromeTarget[]).filter(
        isChatGptTarget,
      )
    : await listChatGptTargets({ host, port });
  const exactTarget = resolveExactChatGptTarget(targets, options.ref);
  const expectedConversationId = expectedConversationIdForRef(
    options.ref,
    exactTarget ?? undefined,
  );
  if (exactTarget) {
    const tab = await inspectChatGptTab({
      host,
      port,
      browserWSEndpoint,
      accountDigest: options.accountDigest,
      expectedConversationId,
      target: exactTarget,
    });
    assertExpectedConversationId(
      expectedConversationId ?? expectedConversationIdForRef(options.ref, tab),
      tab.url,
      "live tab resolution",
    );
    return tab;
  }
  const summaries = await collectChatGptTabsFromTargets(
    host,
    port,
    targets,
    browserWSEndpoint,
    options.accountDigest,
  );
  const tab = resolveChatGptTabFromSummaries(summaries, options.ref);
  assertExpectedConversationId(
    expectedConversationIdForRef(options.ref, tab),
    tab.url,
    "live tab resolution",
  );
  return tab;
}

export interface ChatGptTabConnection {
  client: ChromeClient;
  targetId: string;
  tab: ChatGptTabSummary;
}
async function revalidateConnectedChatGptTab(
  client: ChromeClient,
  tab: ChatGptTabSummary,
  expectedConversationId: string | undefined,
  accountDigest: string | undefined,
  action: string,
): Promise<void> {
  const url = await assertChatGptTabOrigin(client.Runtime, action);
  assertExpectedConversationId(expectedConversationId, url, action);
  const expectedAccountDigest = accountDigest?.trim();
  if (expectedAccountDigest) {
    const observedAccountDigest = await readChatGptAccountDigest(client.Runtime);
    if (observedAccountDigest !== expectedAccountDigest) {
      throw new Error(`Remote Chrome account identity changed before ${action}.`);
    }
  }
  tab.url = url;
  tab.conversationId = extractConversationIdFromUrl(url);
  tab.fingerprint = buildTargetFingerprint(tab);
}

export async function connectToExistingChatGptTab(
  options: ResolveChatGptTabOptions = {},
): Promise<ChatGptTabConnection> {
  const { host, port } = normalizeHostPort(options);
  const browserWSEndpoint = await refreshBoundBrowserEndpoint(options);
  if (browserWSEndpoint) {
    const targets = (
      (await listRemoteChromeTargets({
        host,
        port,
        browserWSEndpoint,
      })) as ChromeTarget[]
    ).filter(isChatGptTarget);
    const exactTarget = resolveExactChatGptTarget(targets, options.ref);
    let expectedConversationId = expectedConversationIdForRef(
      options.ref,
      exactTarget ?? undefined,
    );
    const tab = exactTarget
      ? await inspectChatGptTab({
          host,
          port,
          target: exactTarget,
          browserWSEndpoint,
          accountDigest: options.accountDigest,
          expectedConversationId,
        })
      : resolveChatGptTabFromSummaries(
          await collectChatGptTabsFromTargets(
            host,
            port,
            targets,
            browserWSEndpoint,
            options.accountDigest,
          ),
          options.ref,
        );
    expectedConversationId ??= expectedConversationIdForRef(options.ref, tab);
    assertExpectedConversationId(expectedConversationId, tab.url, "live tab resolution");
    const connection = await connectToRemoteChromeTarget(host, port, noopLogger, {
      browserWSEndpoint,
      targetId: tab.targetId,
      closeTargetOnDispose: options.closeTargetOnDispose ?? false,
    });
    try {
      await revalidateConnectedChatGptTab(
        connection.client,
        tab,
        expectedConversationId,
        options.accountDigest,
        "existing-tab connection",
      );
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
    Object.defineProperty(connection.client, "close", {
      configurable: true,
      value: connection.close,
    });
    return { client: connection.client, targetId: tab.targetId, tab };
  }
  const targets = await listChatGptTargets({ host, port });
  const exactTarget = resolveExactChatGptTarget(targets, options.ref);
  const tab = exactTarget
    ? summaryFromTarget(host, port, exactTarget)
    : await resolveChatGptTab({ host, port, ref: options.ref });
  const expectedConversationId = expectedConversationIdForRef(options.ref, exactTarget ?? tab);
  assertExpectedConversationId(expectedConversationId, tab.url, "live tab resolution");
  const targetId = exactTarget ? extractTargetId(exactTarget) : tab.targetId;
  if (!targetId) {
    throw new Error("Resolved ChatGPT tab is missing a target id.");
  }
  const client = await connectToTarget(host, port, targetId);
  try {
    await revalidateConnectedChatGptTab(
      client,
      tab,
      expectedConversationId,
      options.accountDigest,
      "existing-tab connection",
    );
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  if (options.closeTargetOnDispose) {
    const detach = client.close.bind(client);
    Object.defineProperty(client, "close", {
      configurable: true,
      value: async () => {
        const failures: unknown[] = [];
        try {
          await detach();
        } catch (error) {
          failures.push(error);
        }
        if (!(await closeTab(port, targetId, noopLogger, host))) {
          failures.push(new Error("ChatGPT target cleanup was not confirmed."));
        }
        if (failures.length) {
          throw new AggregateError(failures, "ChatGPT target cleanup failed.");
        }
      },
    });
  }
  return { client, targetId, tab };
}

export async function harvestChatGptTab(
  options: HarvestChatGptTabOptions = {},
): Promise<ChatGptTabSummary> {
  const browserWSEndpoint = await refreshBoundBrowserEndpoint(options);
  const { host, port } = normalizeHostPort(options);
  const initialExpectedConversationId =
    options.expectedConversationId ?? expectedConversationIdForRef(options.ref, options.target);
  const resolved = options.target
    ? await inspectChatGptTab({
        ...options,
        browserWSEndpoint,
        expectedConversationId: initialExpectedConversationId,
        target: options.target,
      })
    : await resolveChatGptTab({ ...options, browserWSEndpoint, ref: options.ref });
  const expectedConversationId =
    initialExpectedConversationId ?? expectedConversationIdForRef(options.ref, resolved);
  assertExpectedConversationId(expectedConversationId, resolved.url, "live tab resolution");
  const client = await connectToTarget(host, port, resolved.targetId, browserWSEndpoint);
  try {
    const { Runtime } = client;
    await revalidateConnectedChatGptTab(
      client,
      resolved,
      expectedConversationId,
      options.accountDigest,
      "live tab harvest",
    );
    const snapshotUrl = await assertChatGptTabOrigin(Runtime, "live tab harvest snapshot");
    assertExpectedConversationId(expectedConversationId, snapshotUrl, "live tab harvest snapshot");
    const snapshot = await readAssistantSnapshot(Runtime, undefined, expectedConversationId).catch(
      () => null,
    );
    const nowSummary = await inspectChatGptTab({
      ...options,
      host,
      browserWSEndpoint,
      expectedConversationId,
      port,
      target: {
        targetId: resolved.targetId,
        title: resolved.title,
        url: resolved.url,
        type: "page",
      },
    });
    assertExpectedConversationId(
      expectedConversationId,
      nowSummary.url,
      "live tab harvest completion",
    );
    const normalizedSnapshotText = normalizeTitle(snapshot?.text ?? "").toLowerCase();
    const normalizedInspectedText = normalizeTitle(nowSummary.lastAssistantText).toLowerCase();
    const snapshotMatchesLatestTurn =
      (typeof snapshot?.turnIndex === "number" &&
        snapshot.turnIndex === nowSummary.lastAssistantTurnIndex) ||
      (snapshot?.turnIndex == null &&
        nowSummary.lastAssistantTurnIndex === undefined &&
        normalizedSnapshotText.length > 0 &&
        normalizedSnapshotText === normalizedInspectedText);
    let assistantMarkdown: string | null = null;
    if (snapshotMatchesLatestTurn && (snapshot?.messageId || snapshot?.turnId)) {
      const captureUrl = await assertChatGptTabOrigin(Runtime, "live tab harvest capture");
      assertExpectedConversationId(expectedConversationId, captureUrl, "live tab harvest capture");
      assistantMarkdown = await captureAssistantMarkdown(
        Runtime,
        {
          messageId: snapshot.messageId,
          turnId: snapshot.turnId,
        },
        noopLogger,
        expectedConversationId,
      ).catch(() => null);
    }
    const lastAssistantText =
      snapshotMatchesLatestTurn &&
      typeof snapshot?.text === "string" &&
      snapshot.text.trim().length > 0
        ? snapshot.text.trim()
        : nowSummary.lastAssistantText;
    const harvested: ChatGptTabSummary = {
      ...nowSummary,
      lastAssistantText,
      lastAssistantSnippet: trimToSnippet(lastAssistantText),
      lastAssistantMarkdown: assistantMarkdown ?? (lastAssistantText || null),
      lastAssistantMessageId:
        snapshotMatchesLatestTurn && typeof snapshot?.messageId === "string"
          ? snapshot.messageId
          : nowSummary.lastAssistantMessageId,
      lastAssistantTurnId:
        snapshotMatchesLatestTurn && typeof snapshot?.turnId === "string"
          ? snapshot.turnId
          : nowSummary.lastAssistantTurnId,
    };
    if (harvested.stopExists && options.stallWindowMs && options.stallWindowMs > 0) {
      const firstFingerprint = harvested.fingerprint;
      await delay(options.stallWindowMs);
      const followup = await inspectChatGptTab({
        ...options,
        host,
        browserWSEndpoint,
        port,
        expectedConversationId,
        target: {
          targetId: harvested.targetId,
          title: harvested.title,
          url: harvested.url,
          type: "page",
        },
      });
      assertExpectedConversationId(
        expectedConversationId,
        followup.url,
        "live tab harvest completion",
      );
      harvested.stopExists = followup.stopExists;
      harvested.sendExists = followup.sendExists;
      harvested.promptReady = followup.promptReady;
      harvested.currentModelLabel = followup.currentModelLabel;
      harvested.focused = followup.focused;
      harvested.visibilityState = followup.visibilityState;
      harvested.assistantCount = followup.assistantCount;
      harvested.authenticated = followup.authenticated;
      harvested.loginButtonExists = followup.loginButtonExists;
      harvested.lastUserText = followup.lastUserText;
      harvested.lastUserSnippet = followup.lastUserSnippet;
      harvested.assistantFollowsLatestUser = followup.assistantFollowsLatestUser;
      harvested.lastAssistantTurnIndex = followup.lastAssistantTurnIndex;
      harvested.lastUserTurnIndex = followup.lastUserTurnIndex;
      harvested.fingerprint = followup.fingerprint;
      harvested.state =
        harvested.stopExists && firstFingerprint === followup.fingerprint
          ? "stalled"
          : classifyTabState(harvested);
    } else {
      harvested.state = classifyTabState(harvested);
    }
    assertExpectedConversationId(
      expectedConversationId,
      harvested.url,
      "live tab harvest completion",
    );
    return harvested;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function extractConversationIdFromUrl(url: string): string | undefined {
  const parsed = parseChatGptUrl(url);
  return parsed ? extractStableConversationIdFromUrl(parsed.pathname) : undefined;
}

export function formatBrowserTabState(
  tab: Pick<
    ChatGptTabSummary,
    "state" | "authenticated" | "stopExists" | "sendExists" | "promptReady" | "assistantCount"
  >,
): BrowserHarvestState {
  return tab.state ?? classifyTabState(tab);
}

export function sessionMatchesTab(meta: SessionMetadata, tab: Partial<ChatGptTabSummary>): boolean {
  const runtime = meta?.browser?.runtime ?? {};
  const harvest = meta?.browser?.harvest ?? {};
  const conversationId = tab.conversationId ?? extractConversationIdFromUrl(tab.url ?? "");
  const portMatches = [runtime.chromePort, meta?.browser?.config?.remoteChrome?.port]
    .filter(Boolean)
    .some(
      (port) =>
        Number(port) === Number(DEFAULT_REMOTE_CHROME_PORT) ||
        Number(port) === Number(tab.port ?? port),
    );
  const hostMatches = [runtime.chromeHost, meta?.browser?.config?.remoteChrome?.host]
    .filter(Boolean)
    .every((host) => !host || host === (tab.host ?? host));
  if (!hostMatches) {
    return false;
  }
  const matches = [
    runtime.chromeTargetId && runtime.chromeTargetId === tab.targetId,
    harvest.targetId && harvest.targetId === tab.targetId,
    runtime.tabUrl && runtime.tabUrl === tab.url,
    harvest.url && harvest.url === tab.url,
    conversationId && runtime.conversationId && runtime.conversationId === conversationId,
    conversationId && harvest.conversationId && harvest.conversationId === conversationId,
  ].some(Boolean);
  return Boolean(
    matches ||
    (portMatches &&
      conversationId &&
      (runtime.conversationId === conversationId || harvest.conversationId === conversationId)),
  );
}
