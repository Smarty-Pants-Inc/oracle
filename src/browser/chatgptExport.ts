import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { BrowserAutomationError, sanitizeErrorForPersistence } from "../oracle/errors.js";
import type { BrowserArchiveResult, ChromeClient } from "./types.js";
import type { BrowserRunWarning } from "../sessionStore.js";
import { archiveChatGptConversation } from "./actions/archiveConversation.js";
import {
  connectToExistingChatGptTab,
  DEFAULT_REMOTE_CHROME_HOST,
  DEFAULT_REMOTE_CHROME_PORT,
  openChatGptTarget,
} from "./liveTabs.js";
import { closeRemoteChromeTarget, connectToRemoteChromeTarget } from "./chromeLifecycle.js";
import { delay } from "./utils.js";
import {
  chatGptConversationScopeFromUrl,
  isSameChatGptConversationScope,
} from "./conversationUrl.js";
import {
  browserIdFromWebSocketEndpoint,
  resolveRemoteChromeBrowserIdentity,
} from "./profileState.js";
import { readChatGptAccountDigest, readChatGptIdentityDigests } from "./pageActions.js";
import { assertChatGptIdentity } from "./chatgptAccountRouter.js";
import {
  acquireOpenBrowserUseRunLock,
  connectOpenBrowserUseTab,
  prepareOpenBrowserUseConversationRoute,
  registerOpenBrowserUseTerminationHooks,
  type OpenBrowserUseConnection,
} from "./openBrowserUse.js";

type JsonRecord = Record<string, unknown>;

interface BackendMessage {
  id?: string;
  author?: {
    role?: string;
    name?: string;
  };
  content?: JsonRecord;
  metadata?: JsonRecord;
  create_time?: number | string | null;
  update_time?: number | string | null;
  status?: string;
  channel?: string | null;
  recipient?: string | null;
}

interface BackendNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: BackendMessage | null;
}

interface BackendConversation {
  title?: string;
  conversation_id?: string;
  current_node?: string;
  mapping?: Record<string, BackendNode>;
  [key: string]: unknown;
}

export interface ChatGptExportTurnAffinity {
  promptMessageId: string;
  assistantMessageId: string;
}

export interface ChatGptConversationExportOptions {
  targetUrl: string;
  outDir: string;
  tabRef?: string;
  host?: string;
  port?: number;
  browserId?: string;
  browserWSEndpoint?: string;
  accountDigest?: string;
  workspaceDigest?: string;
  timeoutMs?: number;
  chunkSize?: number;
  recoverArchived?: boolean;
  archiveAfterExport?: boolean;
  turnAffinity?: ChatGptExportTurnAffinity;
}

export interface ChatGptConversationExportObuOptions {
  targetUrl: string;
  outDir: string;
  obuSessionId: string;
  obuTabId: number;
  oracleSessionId?: string;
  email: string;
  workspaceName: string;
  accountDigest: string;
  workspaceDigest: string;
  timeoutMs?: number;
  chunkSize?: number;
  archiveAfterExport?: boolean;
  turnAffinity: ChatGptExportTurnAffinity;
}

export interface ChatGptConversationExportResult {
  ok: true;
  outputDir: string;
  targetUrl: string;
  targetApiUrl: string;
  conversationId: string;
  title?: string;
  targetId: string;
  tabUrl: string;
  rawBackendPath: string;
  rawBackendSha256: string;
  rawBackendSizeBytes: number;
  payloadPath: string;
  markdownPath: string;
  manifestPath: string;
  captureInfoPath: string;
  sha256SumsPath: string;
  mappingCount: number;
  currentPathNodeCount: number;
  turnCount: number;
  stats: Record<string, unknown>;
  archiveRecovery: ChatGptArchiveRecoveryResult;
  postExportArchive?: BrowserArchiveResult;
  warnings?: BrowserRunWarning[];
}

export interface ChatGptArchiveRecoveryResult {
  attempted: boolean;
  recovered: boolean;
  status: "not-needed" | "recovered";
  settingsUrl?: string;
  patchStatus?: number;
}
type ArchivedPatchOutcome = "not-started" | "in-flight" | "succeeded" | "failed" | "unknown";

interface CaptureHitSummary {
  kind?: string;
  url?: string;
  status?: number;
  ok?: boolean;
  contentType?: string | null;
  chars?: number;
}

export interface CapturePollResult {
  hit?: CaptureHitSummary | null;
  ownerMatched?: boolean;
  requests?: {
    started: number;
    pending: number;
    completed: number;
  };
}

type EvaluateExpression = <T>(expression: string, timeoutLabel?: string) => Promise<T>;
const PASSIVE_CAPTURE_WINDOW_MS = 2_000;

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "OPENAI_API_KEY assignment", pattern: /OPENAI_API_KEY\s*[:=]\s*\S+/i },
  { label: "ANTHROPIC_API_KEY assignment", pattern: /ANTHROPIC_API_KEY\s*[:=]\s*\S+/i },
  { label: "API_KEY assignment", pattern: /\bAPI_KEY\s*[:=]\s*\S+/i },
  { label: "SECRET assignment", pattern: /\bSECRET\s*[:=]\s*\S+/i },
  { label: "TOKEN assignment", pattern: /\bTOKEN\s*[:=]\s*\S+/i },
  { label: "PASSWORD assignment", pattern: /\bPASSWORD\s*[:=]\s*\S+/i },
  { label: "private key", pattern: /-----BEGIN PRIVATE KEY-----/ },
  { label: "ghp token", pattern: /\bghp_[A-Za-z0-9_]{20,}\b/ },
  { label: "xoxb token", pattern: /\bxoxb-[A-Za-z0-9-]{20,}\b/ },
  { label: "sk token", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
];

function remainingCaptureBudget(deadline: number): number {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error("Timed out waiting for backend conversation capture.");
  }
  return remainingMs;
}

export function remainingCaptureBudgetForTest(deadline: number): number {
  return remainingCaptureBudget(deadline);
}

async function runBeforeCaptureDeadline<T>(
  deadline: number,
  operation: (remainingMs: number) => Promise<T>,
): Promise<T> {
  const remainingMs = remainingCaptureBudget(deadline);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Timed out waiting for backend conversation capture.")),
        remainingMs,
      );
    });
    const result = await Promise.race([timeout, operation(remainingMs)]);
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for backend conversation capture.");
    }
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function runBeforeCaptureDeadlineForTest<T>(
  deadline: number,
  operation: (remainingMs: number) => Promise<T>,
): Promise<T> {
  return runBeforeCaptureDeadline(deadline, operation);
}

const SECRET_MARKER_MENTIONS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "API_KEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
];

export function conversationIdFromChatGptUrl(rawUrl: string): string {
  const scope = chatGptConversationScopeFromUrl(rawUrl);
  if (!scope) {
    throw new Error(
      "target-url must be a specific ChatGPT conversation URL: https://chatgpt.com/c/<conversation-id> or https://chatgpt.com/g/<project>/c/<conversation-id>",
    );
  }
  return scope.conversationId;
}
function chatGptConversationScope(rawUrl: string): {
  conversationId: string;
  projectKey: string | null;
} {
  const scope = chatGptConversationScopeFromUrl(rawUrl);
  if (!scope) {
    throw new Error(
      "target-url must be https://chatgpt.com/c/<conversation-id> or https://chatgpt.com/g/<project>/c/<conversation-id>",
    );
  }
  return scope;
}

export function buildBackendConversationUrl(conversationId: string): string {
  return `https://chatgpt.com/backend-api/conversation/${conversationId}`;
}

export function archivedSettingsUrlFromConversationUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const project = /^(\/g\/[^/?#]+)\/c\/[^/?#]+\/?$/.exec(parsed.pathname)?.[1];
  const base = project ? `${parsed.origin}${project}/project` : `${parsed.origin}/`;
  return `${base}#settings/DataControls/ArchivedChats`;
}

export function isSameConversationUrl(actualUrl: string, expectedUrl: string): boolean {
  try {
    conversationIdFromChatGptUrl(actualUrl);
    conversationIdFromChatGptUrl(expectedUrl);
    return isSameChatGptConversationScope(actualUrl, expectedUrl);
  } catch {
    return false;
  }
}
function buildExpectedConversationScopeCheckExpression(expectedUrl: string): string {
  const expected = chatGptConversationScope(expectedUrl);
  return `
(() => {
  const expectedConversationId = ${JSON.stringify(expected.conversationId)};
  const expectedProjectKey = ${JSON.stringify(expected.projectKey)};
  const stableProjectKey = (value) => {
    if (!value) return null;
    return (String(value).match(/^(g-p-[0-9a-f]{32})(?=-|$)/iu)?.[1] || String(value)).toLowerCase();
  };
  try {
    const actual = new URL(location.href);
    if (
      actual.origin !== "https://chatgpt.com" ||
      actual.username ||
      actual.password ||
      actual.pathname.includes("%")
    ) {
      return false;
    }
    const projectConversation = /^\\/g\\/([^/?#]+)\\/c\\/([^/?#]+)\\/?$/.exec(actual.pathname);
    const rootConversation = /^\\/c\\/([^/?#]+)\\/?$/.exec(actual.pathname);
    const conversationId = projectConversation?.[2] || rootConversation?.[1] || null;
    const projectKey = stableProjectKey(projectConversation?.[1]);
    return conversationId === expectedConversationId && projectKey === expectedProjectKey;
  } catch {
    return false;
  }
})()
`.trim();
}

async function isExpectedConversationScope(
  Runtime: ChromeClient["Runtime"],
  expectedUrl: string,
  timeoutLabel: string,
): Promise<boolean> {
  return evaluateByValue<boolean>(
    Runtime,
    buildExpectedConversationScopeCheckExpression(expectedUrl),
    timeoutLabel,
  );
}

async function assertChatGptExportMutationAffinity(
  Runtime: ChromeClient["Runtime"],
  expectedAccountDigest: string | undefined,
  expectedUrl: string,
  action: string,
  expectedWorkspaceDigest?: string,
  captureDeadline?: number,
): Promise<void> {
  const evaluateBeforeDeadline = <T>(operation: () => Promise<T>) =>
    captureDeadline === undefined
      ? operation()
      : runBeforeCaptureDeadline(captureDeadline, () => operation());
  if (expectedWorkspaceDigest) {
    const observed = await evaluateBeforeDeadline(() => readChatGptIdentityDigests(Runtime));
    if (observed.accountDigest !== expectedAccountDigest) {
      throw new Error(`Remote Chrome account identity changed before ${action}.`);
    }
    if (observed.workspaceDigest !== expectedWorkspaceDigest) {
      throw new Error(`Remote Chrome workspace identity changed before ${action}.`);
    }
  } else if (expectedAccountDigest) {
    const observedAccountDigest = await evaluateBeforeDeadline(() =>
      readChatGptAccountDigest(Runtime),
    );
    if (observedAccountDigest !== expectedAccountDigest) {
      throw new Error(`Remote Chrome account identity changed before ${action}.`);
    }
  }
  if (
    !(await evaluateBeforeDeadline(() =>
      isExpectedConversationScope(Runtime, expectedUrl, "conversation scope"),
    ))
  ) {
    throw new Error(`ChatGPT conversation changed before ${action}.`);
  }
}

export async function assertChatGptExportMutationAffinityForTest(
  Runtime: ChromeClient["Runtime"],
  expectedAccountDigest: string | undefined,
  expectedUrl: string,
  action = "archive mutation",
  expectedWorkspaceDigest?: string,
  captureDeadline?: number,
): Promise<void> {
  await assertChatGptExportMutationAffinity(
    Runtime,
    expectedAccountDigest,
    expectedUrl,
    action,
    expectedWorkspaceDigest,
    captureDeadline,
  );
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

export function buildScopedBackendCaptureHook(
  targetApiUrl: string,
  options: {
    targetUrl?: string;
    accountDigest?: string;
    workspaceDigest?: string;
    owner?: string;
  } = {},
): string {
  const routeCheck = options.targetUrl
    ? buildExpectedConversationScopeCheckExpression(options.targetUrl)
    : "true";
  const owner = options.owner?.trim() || randomUUID();
  return `
(() => {
  const TARGET = ${jsString(targetApiUrl)};
  const VERSION = 2;
  const OWNER = ${jsString(owner)};
  const STORAGE_KEY = "__oracleChatGptBackendCapture:" + TARGET;
  const STORAGE_OWNER_KEY = "__oracleChatGptBackendCaptureOwner:" + TARGET;
  const DISABLED_KEY = "__oracleChatGptBackendCaptureDisabled:v2:" + TARGET;
  try {
    if (sessionStorage.getItem(DISABLED_KEY) !== null) return;
  } catch {
    return;
  }
  try {
    if (new URL(location.href).origin !== "https://chatgpt.com") return;
  } catch {
    return;
  }
  const EXPECTED_ACCOUNT_DIGEST = ${jsString(options.accountDigest?.trim() ?? "")};
  const EXPECTED_WORKSPACE_DIGEST = ${jsString(options.workspaceDigest?.trim() ?? "")};
  const EXPECTED_CONVERSATION_ID = TARGET.slice(TARGET.lastIndexOf("/") + 1);
  const isApprovedText = (value) => {
    try {
      return JSON.parse(String(value || ""))?.conversation_id === EXPECTED_CONVERSATION_ID;
    } catch {
      return false;
    }
  };
  const routeMatches = () => Boolean(${routeCheck});
  const existing = window.__oracleChatGptBackendCapture;
  if (existing?.target === TARGET && existing?.active) {
    if (existing.version === VERSION) return;
    try {
      existing.active = false;
      if (window.fetch === existing.fetchWrapper) {
        if (typeof existing.originalFetch !== "function") return;
        window.fetch = existing.originalFetch;
      }
      if (window.XMLHttpRequest === existing.xmlHttpRequestWrapper) {
        if (!existing.originalXMLHttpRequest) return;
        window.XMLHttpRequest = existing.originalXMLHttpRequest;
      }
      if (Array.isArray(existing.hits)) existing.hits.length = 0;
      const selection = window.__oracleChatGptBackendCaptureSelection;
      if (selection?.capture === existing) {
        try {
          if (selection && typeof selection === "object" && "text" in selection) selection.text = "";
        } catch {}
        try { delete window.__oracleChatGptBackendCaptureSelection; } catch {}
      }
      if (window.__oracleChatGptBackendCapture === existing) {
        delete window.__oracleChatGptBackendCapture;
      }
    } catch {
      return;
    }
  }
  const originalFetch = window.fetch;
  const OriginalXHR = window.XMLHttpRequest;
  const state = window.__oracleChatGptBackendCapture = {
    version: VERSION,
    owner: OWNER,
    target: TARGET,
    active: true,
    originalFetch,
    originalXMLHttpRequest: OriginalXHR,
    hits: [],
    requests: { started: 0, pending: 0, completed: 0 }
  };
  const isActive = () => state.active && window.__oracleChatGptBackendCapture === state;
  const digest = async (value) => {
    if (typeof value !== "string" || !value.trim() || !globalThis.crypto?.subtle) return "";
    const bytes = new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(value.trim()),
    ));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const captureAffinityMatches = async () => {
    if (!routeMatches()) return false;
    if (!EXPECTED_ACCOUNT_DIGEST && !EXPECTED_WORKSPACE_DIGEST) return true;
    try {
      const response = await originalFetch.call(window, "/api/auth/session", {
        cache: "no-store",
        credentials: "include"
      });
      if (!response.ok) return false;
      const body = await response.json();
      if (
        EXPECTED_ACCOUNT_DIGEST &&
        await digest(body?.user?.id) !== EXPECTED_ACCOUNT_DIGEST
      ) return false;
      if (
        EXPECTED_WORKSPACE_DIGEST &&
        await digest(body?.account?.id) !== EXPECTED_WORKSPACE_DIGEST
      ) return false;
      return routeMatches();
    } catch {
      return false;
    }
  };
  const currentPageCredentials = async () => {
    if (!routeMatches()) return null;
    try {
      const bootstrap = JSON.parse(document.getElementById("client-bootstrap")?.textContent || "{}");
      const session = bootstrap?.session;
      const accessToken = typeof session?.accessToken === "string" ? session.accessToken : "";
      const accountId = typeof session?.account?.id === "string" ? session.account.id : "";
      if (!accessToken || !accountId) return null;
      if (
        EXPECTED_ACCOUNT_DIGEST &&
        await digest(session?.user?.id) !== EXPECTED_ACCOUNT_DIGEST
      ) return null;
      if (
        EXPECTED_WORKSPACE_DIGEST &&
        await digest(accountId) !== EXPECTED_WORKSPACE_DIGEST
      ) return null;
      return routeMatches() ? { accessToken, accountId } : null;
    } catch {
      return null;
    }
  };
  const requestAffinityMatches = async (authorization, workspaceId) => {
    if (!EXPECTED_ACCOUNT_DIGEST && !EXPECTED_WORKSPACE_DIGEST) {
      return captureAffinityMatches();
    }
    const [identityMatched, credentials] = await Promise.all([
      captureAffinityMatches(),
      currentPageCredentials(),
    ]);
    if (!identityMatched || !credentials) return false;
    const authorizationMatches =
      !authorization || authorization === "Bearer " + credentials.accessToken;
    const workspaceMatches = !workspaceId || workspaceId === credentials.accountId;
    return authorizationMatches && workspaceMatches;
  };
  const resolveUrl = (input) => {
    try {
      return new URL(typeof input === "string" ? input : (input && input.url) || "", location.href).href;
    } catch {
      return "";
    }
  };
  const begin = (kind, input, method, headers) => {
    const url = resolveUrl(input);
    if (!isActive() || url !== TARGET || String(method || "GET").toUpperCase() !== "GET") {
      return null;
    }
    state.requests.started += 1;
    state.requests.pending += 1;
    return {
      kind,
      url,
      affinity: requestAffinityMatches(
        headers?.get?.("authorization") || "",
        headers?.get?.("ChatGPT-Account-Id") || "",
      ),
    };
  };
  const finish = () => {
    if (!isActive()) return;
    state.requests.pending = Math.max(0, state.requests.pending - 1);
    state.requests.completed += 1;
  };
  const recordError = (request, error) => {
    if (!isActive()) return;
    state.hits.push({
      kind: request.kind,
      url: request.url,
      error: String(error),
      capturedAt: new Date().toISOString()
    });
  };
  const persist = (capturedText) => {
    try {
      const storedOwner = sessionStorage.getItem(STORAGE_OWNER_KEY);
      const storedPayload = sessionStorage.getItem(STORAGE_KEY);
      if (
        (storedOwner !== null && storedOwner !== OWNER) ||
        (storedOwner === null && storedPayload !== null)
      ) return;
      sessionStorage.setItem(STORAGE_OWNER_KEY, OWNER);
      sessionStorage.setItem(STORAGE_KEY, capturedText);
    } catch {}
  };
  const record = async (request, response) => {
    try {
      if (!isActive()) return;
      const text = await response.clone().text();
      const affinityMatched =
        isApprovedText(text) &&
        await request.affinity &&
        await captureAffinityMatches();
      if (!isActive()) return;
      const capturedText = affinityMatched ? text : "";
      if (affinityMatched) persist(capturedText);
      state.hits.push({
        kind: request.kind,
        url: request.url,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type"),
        chars: capturedText.length,
        text: capturedText,
        affinityMatched,
        capturedAt: new Date().toISOString()
      });
    } catch (error) {
      recordError(request, error);
    } finally {
      finish();
    }
  };
  state.fetchWrapper = window.fetch = function(input, init) {
    let headers;
    try {
      headers = new Request(input, init).headers;
    } catch {
      headers = new Headers(init?.headers);
    }
    const request = begin(
      "fetch",
      input,
      init?.method || (input && input.method) || "GET",
      headers,
    );
    let responsePromise;
    try {
      responsePromise = originalFetch.apply(this, arguments);
    } catch (error) {
      if (request) {
        recordError(request, error);
        finish();
      }
      throw error;
    }
    return Promise.resolve(responsePromise).then(
      (response) => {
        if (request) void record(request, response);
        return response;
      },
      (error) => {
        if (request) {
          recordError(request, error);
          finish();
        }
        throw error;
      }
    );
  };
  state.xmlHttpRequestWrapper = window.XMLHttpRequest = function() {
    const xhr = new OriginalXHR();
    let requestUrl = "";
    let requestMethod = "GET";
    let request = null;
    let requestHeaders = new Headers();
    const open = xhr.open;
    xhr.open = function(method, url) {
      requestHeaders = new Headers();
      requestMethod = String(method || "GET");
      requestUrl = String(url || "");
      return open.apply(xhr, arguments);
    };
    const setRequestHeader = xhr.setRequestHeader;
    if (typeof setRequestHeader === "function") {
      xhr.setRequestHeader = function(name, value) {
        requestHeaders.append(String(name), String(value));
        return setRequestHeader.apply(xhr, arguments);
      };
    }
    const send = xhr.send;
    xhr.send = function() {
      request = begin("xhr", requestUrl, requestMethod, requestHeaders);
      try {
        return send.apply(xhr, arguments);
      } catch (error) {
        if (request) {
          recordError(request, error);
          finish();
          request = null;
        }
        throw error;
      }
    };
    xhr.addEventListener("loadend", async () => {
      const tracked = request;
      request = null;
      if (!tracked) return;
      if (!isActive()) return;
      try {
        const responseType = String(xhr.responseType || "").toLowerCase();
        const text =
          responseType === "json"
            ? JSON.stringify(xhr.response ?? null)
            : responseType === "" || responseType === "text"
              ? String(xhr.responseText || "")
              : "";
        const affinityMatched =
          isApprovedText(text) &&
          await tracked.affinity &&
          await captureAffinityMatches();
        if (!isActive()) return;
        const capturedText = affinityMatched ? text : "";
        if (affinityMatched) persist(capturedText);
        state.hits.push({
          kind: tracked.kind,
          url: tracked.url,
          status: xhr.status,
          ok: xhr.status >= 200 && xhr.status < 300,
          contentType: xhr.getResponseHeader("content-type"),
          chars: capturedText.length,
          text: capturedText,
          affinityMatched,
          capturedAt: new Date().toISOString()
        });
      } catch (error) {
        recordError(tracked, error);
      } finally {
        finish();
      }
    });
    return xhr;
  };
  state.cleanup = () => {
    const wasActive = state.active;
    state.active = false;
    let payloadCleared = false;
    try {
      state.hits.length = 0;
      payloadCleared = state.hits.length === 0;
    } catch {}
    let storageRemoved = true;
    try {
      const storedOwner = sessionStorage.getItem(STORAGE_OWNER_KEY);
      const storedPayload = sessionStorage.getItem(STORAGE_KEY);
      if (storedOwner !== null && storedOwner !== OWNER) {
        storageRemoved = false;
      } else if (storedOwner === OWNER) {
        sessionStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem(STORAGE_OWNER_KEY);
        storageRemoved =
          sessionStorage.getItem(STORAGE_KEY) === null &&
          sessionStorage.getItem(STORAGE_OWNER_KEY) === null;
      } else {
        storageRemoved = storedPayload === null;
      }
    } catch {
      storageRemoved = false;
    }
    const fetchOwned = window.fetch === state.fetchWrapper;
    let restoredFetch = !fetchOwned;
    if (fetchOwned) {
      try {
        window.fetch = originalFetch;
        restoredFetch = window.fetch === originalFetch;
      } catch {}
    }
    const xhrOwned = window.XMLHttpRequest === state.xmlHttpRequestWrapper;
    let restoredXMLHttpRequest = !xhrOwned;
    if (xhrOwned) {
      try {
        window.XMLHttpRequest = OriginalXHR;
        restoredXMLHttpRequest = window.XMLHttpRequest === OriginalXHR;
      } catch {}
    }
    const selection = window.__oracleChatGptBackendCaptureSelection;
    const ownsSelection =
      selection?.capture === state || (selection?.target === TARGET && selection?.owner === OWNER);
    let selectionPayloadCleared = true;
    if (ownsSelection) {
      try {
        if (selection && typeof selection === "object" && "text" in selection) {
          try {
            selection.text = "";
          } catch {
            selectionPayloadCleared = false;
          }
          if (selection.text !== "") selectionPayloadCleared = false;
        }
      } catch {
        selectionPayloadCleared = false;
      }
      try {
        delete window.__oracleChatGptBackendCaptureSelection;
      } catch {}
    }
    const remainingSelection = window.__oracleChatGptBackendCaptureSelection;
    const selectionRemoved = remainingSelection?.target !== TARGET;
    const cleanupComplete =
      payloadCleared &&
      restoredFetch &&
      restoredXMLHttpRequest &&
      storageRemoved &&
      selectionPayloadCleared &&
      selectionRemoved;
    if (cleanupComplete && window.__oracleChatGptBackendCapture === state) {
      delete window.__oracleChatGptBackendCapture;
    }
    return {
      status: wasActive ? "cleaned" : "already-cleaned",
      deactivated: state.active === false,
      ownerMatched: state.version === VERSION && state.owner === OWNER,
      restoredFetch,
      restoredXMLHttpRequest,
      stateRemoved: window.__oracleChatGptBackendCapture !== state,
      selectionRemoved,
      storageRemoved,
      payloadCleared,
    };
  };

})();
`.trim();
}

export function buildApprovedBackendFetchExpression(options: {
  targetUrl: string;
  targetApiUrl: string;
  email: string;
  accountDigest: string;
  workspaceDigest: string;
  timeoutMs?: number;
  captureOwner?: string;
}): string {
  const expectedScope = chatGptConversationScope(options.targetUrl);
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 45_000));
  return `(() => (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ${timeoutMs});
    try {
    const expectedConversationId = ${jsString(expectedScope.conversationId)};
    const expectedProjectKey = ${JSON.stringify(expectedScope.projectKey)};
    const targetApiUrl = ${jsString(options.targetApiUrl)};
    const expectedEmail = ${jsString(options.email.trim().toLowerCase())};
    const expectedAccountDigest = ${jsString(options.accountDigest)};
    const expectedWorkspaceDigest = ${jsString(options.workspaceDigest)};
    const expectedCaptureOwner = ${jsString(options.captureOwner?.trim() ?? "")};
    const stableProjectKey = (value) => {
      if (typeof value !== "string" || !value) return null;
      return (value.match(/^(g-p-[0-9a-f]{32})(?=-|$)/i)?.[1] || value).toLowerCase();
    };
    const digest = async (value) => {
      if (typeof value !== "string" || !value.trim() || !globalThis.crypto?.subtle) return "";
      const bytes = new Uint8Array(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(value.trim()),
      ));
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const scopeMatches = () => {
      try {
        const actual = new URL(location.href);
        if (
          actual.origin !== "https://chatgpt.com" ||
          actual.username ||
          actual.password ||
          actual.pathname.includes("%")
        ) return false;
        const project = new RegExp("^/g/([^/?#]+)/c/([^/?#]+)/?$").exec(actual.pathname);
        const root = new RegExp("^/c/([^/?#]+)/?$").exec(actual.pathname);
        const actualConversationId = project?.[2] || root?.[1] || null;
        const actualProjectKey = project?.[1] ? stableProjectKey(project[1]) : null;
        return (
          actualConversationId === expectedConversationId &&
          actualProjectKey === expectedProjectKey
        );
      } catch {
        return false;
      }
    };
    const captureOwnerMatches = () => {
      const capture = globalThis.__oracleChatGptBackendCapture;
      return (
        !expectedCaptureOwner ||
        (capture?.target === targetApiUrl &&
          capture?.version === 2 &&
          capture?.owner === expectedCaptureOwner)
      );
    };
    const passiveRequestObserved = () => {
      const capture = globalThis.__oracleChatGptBackendCapture;
      return (
        captureOwnerMatches() &&
        capture?.target === targetApiUrl &&
        Number(capture?.requests?.pending || 0) > 0
      );
    };
    if (!captureOwnerMatches()) return { status: "refused", code: "capture-owner-mismatch" };
    if (!scopeMatches()) return { status: "refused", code: "scope-mismatch" };
    if (passiveRequestObserved()) {
      return { status: "refused", code: "passive-request-observed" };
    }
    let auth;
    try {
      const response = await fetch("/api/auth/session", {
        cache: "no-store",
        credentials: "include",
        signal: controller.signal
      });
      if (!response.ok) return { status: "refused", code: "identity-unavailable" };
      auth = await response.json();
    } catch {
      return {
        status: "refused",
        code: controller.signal.aborted ? "approved-fetch-timeout" : "identity-unavailable"
      };
    }
    const authEmail = typeof auth?.user?.email === "string"
      ? auth.user.email.trim().toLowerCase()
      : "";
    const authAccountDigest = await digest(auth?.user?.id);
    const authWorkspaceDigest = await digest(auth?.account?.id);
    if (
      authEmail !== expectedEmail ||
      authAccountDigest !== expectedAccountDigest ||
      authWorkspaceDigest !== expectedWorkspaceDigest
    ) {
      return { status: "refused", code: "identity-mismatch" };
    }
    if (!scopeMatches()) return { status: "refused", code: "scope-mismatch" };
    let bootstrap;
    try {
      bootstrap = JSON.parse(document.getElementById("client-bootstrap")?.textContent || "{}");
    } catch {
      return { status: "refused", code: "bootstrap-unavailable" };
    }
    const session = bootstrap?.session;
    const bootstrapEmail = typeof session?.user?.email === "string"
      ? session.user.email.trim().toLowerCase()
      : "";
    const bootstrapAccountDigest = await digest(session?.user?.id);
    const bootstrapWorkspaceDigest = await digest(session?.account?.id);
    if (
      bootstrapEmail !== expectedEmail ||
      bootstrapAccountDigest !== expectedAccountDigest ||
      bootstrapWorkspaceDigest !== expectedWorkspaceDigest
    ) {
      return { status: "refused", code: "bootstrap-identity-mismatch" };
    }
    if (!scopeMatches()) return { status: "refused", code: "scope-mismatch" };
    if (!captureOwnerMatches()) return { status: "refused", code: "capture-owner-mismatch" };
    if (passiveRequestObserved()) {
      return { status: "refused", code: "passive-request-observed" };
    }
    const accessToken = session?.accessToken;
    const accountId = session?.account?.id;
    if (!accessToken || !accountId) {
      return { status: "refused", code: "bootstrap-unavailable" };
    }
    try {
      const response = await fetch(targetApiUrl, {
        credentials: "include",
        signal: controller.signal,
        headers: {
          Authorization: "Bearer " + accessToken,
          "ChatGPT-Account-Id": accountId
        }
      });
      return response.ok
        ? { status: "captured", httpStatus: response.status }
        : { status: "refused", code: "backend-request-failed", httpStatus: response.status };
    } catch {
      return {
        status: "refused",
        code: controller.signal.aborted ? "approved-fetch-timeout" : "backend-request-failed"
      };
    }
    } finally {
      clearTimeout(timeoutId);
    }
  })())()`;
}

export async function requestApprovedBackendCapture(options: {
  Runtime: ChromeClient["Runtime"];
  targetUrl: string;
  targetApiUrl: string;
  email: string;
  accountDigest: string;
  workspaceDigest: string;
  timeoutMs: number;
  captureOwner?: string;
}): Promise<boolean> {
  const evaluated = await options.Runtime.evaluate({
    expression: buildApprovedBackendFetchExpression(options),
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluated.exceptionDetails) {
    throw new BrowserAutomationError(
      "The authenticated ChatGPT page could not request the approved conversation.",
      {
        stage: "chatgpt-export",
        code: "approved-fetch-failed",
      },
    );
  }
  const result = evaluated.result?.value as
    | { status?: string; code?: string; httpStatus?: number }
    | undefined;
  if (result?.status === "captured") return true;
  if (result?.code === "passive-request-observed") return false;
  throw new BrowserAutomationError(
    "The authenticated ChatGPT page refused the approved conversation request.",
    {
      stage: "chatgpt-export",
      code: typeof result?.code === "string" ? result.code : "approved-fetch-refused",
      ...(typeof result?.httpStatus === "number" ? { httpStatus: result.httpStatus } : {}),
    },
  );
}

export function buildArchivedConversationRecoveryHookForTest(
  conversationId: string,
  options: {
    targetUrl?: string;
    accountDigest?: string;
    workspaceDigest?: string;
    owner?: string;
  } = {},
): string {
  return buildArchivedConversationRecoveryHook({
    targetUrl: options.targetUrl ?? `https://chatgpt.com/c/${conversationId}`,
    accountDigest: options.accountDigest ?? "a".repeat(64),
    workspaceDigest: options.workspaceDigest ?? "b".repeat(64),
    owner: options.owner,
  });
}

function buildArchivedConversationRecoveryHook(options: {
  targetUrl: string;
  accountDigest: string;
  workspaceDigest: string;
  owner?: string;
}): string {
  const scope = chatGptConversationScope(options.targetUrl);
  const targetApiUrl = buildBackendConversationUrl(scope.conversationId);
  const owner = options.owner?.trim() || randomUUID();
  return `
(() => {
  const TARGET = ${jsString(targetApiUrl)};
  const VERSION = 2;
  const OWNER = ${jsString(owner)};
  const EXPECTED_CONVERSATION_ID = ${jsString(scope.conversationId)};
  const EXPECTED_PROJECT_KEY = ${JSON.stringify(scope.projectKey)};
  const EXPECTED_ACCOUNT_DIGEST = ${jsString(options.accountDigest)};
  const EXPECTED_WORKSPACE_DIGEST = ${jsString(options.workspaceDigest)};
  const KEY = "__oracleArchivedConversationRecovery";
  const DISABLED_KEY = "__oracleArchivedConversationRecoveryDisabled:v2:" + TARGET;
  try {
    if (sessionStorage.getItem(DISABLED_KEY) !== null) return;
  } catch {
    return;
  }
  try {
    if (new URL(location.href).origin !== "https://chatgpt.com") return;
  } catch {
    return;
  }
  const SETTINGS_HASH = "#settings/DataControls/ArchivedChats";
  const existing = window[KEY];
  if (existing?.target === TARGET && existing?.active) {
    if (existing.version === VERSION) return;
    try {
      existing.active = false;
      if (window.fetch === existing.fetchWrapper) {
        if (typeof existing.originalFetch !== "function") return;
        window.fetch = existing.originalFetch;
      }
      if (window[KEY] === existing) delete window[KEY];
    } catch {
      return;
    }
  }
  const originalFetch = window.fetch;
  const state = window[KEY] = {
    version: VERSION,
    owner: OWNER,
    target: TARGET,
    active: true,
    originalFetch,
    status: "pending",
    attempted: false,
    recovered: false,
    patchOutcome: "not-started",
    patchPromise: null
  };
  const isActive = () => state.active && window[KEY] === state;
  const digest = async (value) => {
    if (typeof value !== "string" || !value.trim() || !globalThis.crypto?.subtle) return null;
    const bytes = new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(value.trim()),
    ));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const stableProjectKey = (value) => {
    if (typeof value !== "string" || !value) return null;
    return (value.match(/^(g-p-[0-9a-f]{32})(?=-|$)/i)?.[1] || value).toLowerCase();
  };
  const routeMatches = () => {
    try {
      const current = new URL(location.href);
      if (
        current.origin !== "https://chatgpt.com" ||
        current.username ||
        current.password ||
        current.pathname.includes("%") ||
        current.search !== "" ||
        current.hash !== SETTINGS_HASH
      ) return false;
      if (EXPECTED_PROJECT_KEY === null) return current.pathname === "/";
      const project = new RegExp("^/g/([^/?#]+)/project$").exec(current.pathname);
      return Boolean(project?.[1] && stableProjectKey(project[1]) === EXPECTED_PROJECT_KEY);
    } catch {
      return false;
    }
  };
  const conversationRouteMatches = () => {
    try {
      const current = new URL(location.href);
      if (
        current.origin !== "https://chatgpt.com" ||
        current.username ||
        current.password ||
        current.pathname.includes("%") ||
        current.search !== "" ||
        current.hash !== ""
      ) return false;
      const project = new RegExp("^/g/([^/?#]+)/c/([^/?#]+)/?$").exec(current.pathname);
      const root = new RegExp("^/c/([^/?#]+)/?$").exec(current.pathname);
      const conversationId = project?.[2] || root?.[1] || null;
      const projectKey = project?.[1] ? stableProjectKey(project[1]) : null;
      return conversationId === EXPECTED_CONVERSATION_ID && projectKey === EXPECTED_PROJECT_KEY;
    } catch {
      return false;
    }
  };
  const restoreRouteMatches = () => routeMatches() || conversationRouteMatches();
  const identityMatches = async () => {
    if (!restoreRouteMatches()) return false;
    try {
      const response = await originalFetch.call(window, "/api/auth/session", {
        cache: "no-store",
        credentials: "include"
      });
      if (!response.ok) return false;
      const body = await response.json();
      return (
        await digest(body?.user?.id) === EXPECTED_ACCOUNT_DIGEST &&
        await digest(body?.account?.id) === EXPECTED_WORKSPACE_DIGEST &&
        restoreRouteMatches()
      );
    } catch {
      return false;
    }
  };
  const currentPageCredentials = async (allowConversationRoute = false) => {
    const routeOk = allowConversationRoute ? restoreRouteMatches() : routeMatches();
    if (!routeOk) return null;
    try {
      const bootstrap = JSON.parse(document.getElementById("client-bootstrap")?.textContent || "{}");
      const session = bootstrap?.session;
      const accessToken = typeof session?.accessToken === "string" ? session.accessToken : "";
      const accountId = typeof session?.account?.id === "string" ? session.account?.id : "";
      if (!accessToken || !accountId) return null;
      if (await digest(session?.user?.id) !== EXPECTED_ACCOUNT_DIGEST) return null;
      if (await digest(accountId) !== EXPECTED_WORKSPACE_DIGEST) return null;
      return (allowConversationRoute ? restoreRouteMatches() : routeMatches())
        ? { accessToken, accountId }
        : null;
    } catch {
      return null;
    }
  };
  let restorePromise = null;
  const restoreArchivedConversation = async () => {
    if (!isActive() || !restoreRouteMatches()) return { ok: false, code: "scope-mismatch" };
    if (state.patchPromise && state.patchOutcome === "in-flight") {
      await state.patchPromise.catch(() => undefined);
    }
    if (!isActive() || !restoreRouteMatches()) return { ok: false, code: "scope-mismatch" };
    const credentials = await currentPageCredentials(true);
    if (!credentials || !await identityMatches()) return { ok: false, code: "affinity-mismatch" };
    if (restorePromise) return restorePromise;
    const headers = new Headers();
    headers.set("Authorization", "Bearer " + credentials.accessToken);
    headers.set("ChatGPT-Account-Id", credentials.accountId);
    headers.set("content-type", "application/json");
    restorePromise = originalFetch.call(window, TARGET, {
      method: "PATCH",
      headers,
      credentials: "include",
      body: JSON.stringify({ is_archived: true })
    }).then((response) => ({ ok: response.ok, status: response.status }));
    return restorePromise;
  };
  state.restoreArchivedConversation = restoreArchivedConversation;
  state.fetchWrapper = window.fetch = async function(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url, location.href);
    const isArchivedListRequest =
      isActive() &&
      state.status === "pending" &&
      routeMatches() &&
      request.method.toUpperCase() === "GET" &&
      url.origin === "https://chatgpt.com" &&
      url.pathname === "/backend-api/conversations" &&
      url.searchParams.get("is_archived") === "true";
    const requestIdentity = isArchivedListRequest ? identityMatches() : null;
    const requestCredentials = isArchivedListRequest ? currentPageCredentials() : null;
    const response = await originalFetch.call(window, input, init);
    if (!isActive()) return response;
    try {
      if (isActive() && state.status === "pending" && isArchivedListRequest) {
        state.status = "processing";
        state.attempted = true;
        state.listStatus = response.status;
        if (!response.ok) {
          state.status = "failed";
          state.code = "archived-list-failed";
          return response;
        }
        const headers = new Headers(request.headers);
        const initialCredentials = requestCredentials ? await requestCredentials : null;
        const currentCredentials = await currentPageCredentials();
        const requestWorkspaceDigest = await digest(headers.get("ChatGPT-Account-Id"));
        if (!isActive()) return response;
        if (
          !await requestIdentity ||
          !initialCredentials ||
          !currentCredentials ||
          requestWorkspaceDigest !== EXPECTED_WORKSPACE_DIGEST ||
          !await identityMatches() ||
          initialCredentials.accessToken !== currentCredentials.accessToken ||
          initialCredentials.accountId !== currentCredentials.accountId
        ) {
          state.status = "failed";
          state.code = "affinity-mismatch";
          return response;
        }
        if (!isActive()) return response;
        headers.set("Authorization", "Bearer " + currentCredentials.accessToken);
        headers.set("ChatGPT-Account-Id", currentCredentials.accountId);
        headers.set("content-type", "application/json");
        headers.delete("content-length");
        headers.delete("x-openai-target-path");
        headers.delete("x-openai-target-route");
        if (!routeMatches()) {
          state.status = "failed";
          state.code = "scope-mismatch";
          return response;
        }
        state.patchOutcome = "in-flight";
        state.patchPromise = (async () => {
          try {
            return await originalFetch.call(window, TARGET, {
              method: "PATCH",
              headers,
              credentials: "include",
              body: JSON.stringify({ is_archived: false })
            });
          } catch {
            return null;
          }
        })();
        const patch = await state.patchPromise;
        if (!patch) {
          state.patchOutcome = "unknown";
          state.recovered = false;
          state.status = "failed";
          state.code = "patch-outcome-unknown";
          return response;
        }
        state.patchStatus = patch.status;
        state.patchOutcome = patch.ok ? "succeeded" : "unknown";
        state.recovered = patch.ok;
        state.status = patch.ok ? "recovered" : "failed";
        if (!patch.ok) state.code = "patch-failed";
      }
    } catch {
      if (state.patchOutcome === "in-flight") state.patchOutcome = "unknown";
      state.status = "failed";
      state.code = state.patchOutcome === "unknown" ? "patch-outcome-unknown" : "recovery-failed";
    }
    return response;
  };
  state.cleanup = () => {
    if (state.patchOutcome === "in-flight") {
      return {
        status: "pending-patch",
        pending: true,
        patchOutcome: state.patchOutcome,
        patchStatus: state.patchStatus,
        recovered: state.recovered,
        deactivated: false,
        ownerMatched: state.version === VERSION && state.owner === OWNER,
        restoredFetch: false,
        stateRemoved: false,
      };
    }
    const wasActive = state.active;
    state.active = false;
    const fetchOwned = window.fetch === state.fetchWrapper;
    let restoredFetch = !fetchOwned;
    if (fetchOwned) {
      try {
        window.fetch = originalFetch;
        restoredFetch = window.fetch === originalFetch;
      } catch {}
    }
    if (restoredFetch && window[KEY] === state) delete window[KEY];
    return {
      status: wasActive ? "cleaned" : "already-cleaned",
      pending: false,
      patchOutcome: state.patchOutcome,
      patchStatus: state.patchStatus,
      recovered: state.recovered,
      deactivated: state.active === false,
      ownerMatched: state.version === VERSION && state.owner === OWNER,
      restoredFetch,
      stateRemoved: window[KEY] !== state,
    };
  };
})();
`.trim();
}

async function waitForDocument(Runtime: ChromeClient["Runtime"], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluateByValue<string>(Runtime, "document.readyState", "document ready");
    if (ready === "interactive" || ready === "complete") return;
    await delay(100);
  }
  throw new Error("Timed out waiting for ChatGPT document readiness.");
}

async function waitForConversationUrl(
  Runtime: ChromeClient["Runtime"],
  expectedUrl: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isExpectedConversationScope(Runtime, expectedUrl, "conversation scope")) {
      return expectedUrl;
    }
    await delay(150);
  }
  throw new Error("Recovered conversation did not open at the approved URL.");
}

async function recoverArchivedConversation({
  targetUrl,
  host,
  port,
  browserWSEndpoint,
  accountDigest,
  workspaceDigest,
  timeoutMs,
}: {
  targetUrl: string;
  host: string;
  port: number;
  browserWSEndpoint?: string;
  accountDigest: string;
  workspaceDigest: string;
  timeoutMs: number;
}): Promise<{
  client: ChromeClient;
  targetId: string;
  tabUrl: string;
  recovery: ChatGptArchiveRecoveryResult;
  close: () => Promise<void>;
}> {
  const settingsUrl = archivedSettingsUrlFromConversationUrl(targetUrl);
  const targetApiUrl = buildBackendConversationUrl(conversationIdFromChatGptUrl(targetUrl));
  let client: ChromeClient;
  let targetId: string;
  let close: () => Promise<void>;
  if (browserWSEndpoint) {
    const connection = await connectToRemoteChromeTarget(host, port, () => {}, {
      browserWSEndpoint,
      targetUrl: "https://chatgpt.com/",
      closeTargetOnDispose: true,
    });
    if (!connection.targetId) {
      await connection.close().catch(() => undefined);
      throw new Error("Remote Chrome did not return a target id for archived recovery.");
    }
    client = connection.client;
    targetId = connection.targetId;
    close = connection.close;
  } else {
    targetId = await openChatGptTarget({ host, port, url: "https://chatgpt.com/" });
    try {
      ({ client } = await connectToExistingChatGptTab({ host, port, ref: targetId }));
    } catch (error) {
      await closeRemoteChromeTarget(host, port, targetId, () => {}).catch(() => undefined);
      throw error;
    }
    close = async () => {
      let cleanupError: unknown;
      try {
        await client.close();
      } catch (error) {
        cleanupError = error;
      }
      try {
        await closeRemoteChromeTarget(host, port, targetId, () => {}, {
          throwOnFailure: true,
        });
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError !== undefined) throw cleanupError;
    };
  }
  const { Page, Runtime } = client;
  let recoveryHookInstalled = false;
  let recoveryScriptIdentifier: string | undefined;
  let recoveryRegistrationAttempted = false;
  let completed = false;
  let preserveTargetOnFailure = false;
  let archiveRestored = false;
  let mutationOutcome: ArchivedPatchOutcome = "not-started";
  let mutationStatus: number | undefined;
  let state: JsonRecord = {};
  let surfacedError: unknown;
  let finalCleanupError: unknown;
  const recoveryOwner = randomUUID();
  const updateMutationState = (candidate: JsonRecord) => {
    const outcome = candidate.patchOutcome;
    if (
      outcome === "not-started" ||
      outcome === "in-flight" ||
      outcome === "succeeded" ||
      outcome === "failed" ||
      outcome === "unknown"
    ) {
      mutationOutcome = outcome;
    }
    if (typeof candidate.patchStatus === "number" && Number.isFinite(candidate.patchStatus)) {
      mutationStatus = candidate.patchStatus;
    }
  };
  const compensateArchiveMutation = async (): Promise<boolean> => {
    if (archiveRestored) return true;
    if (
      !new Set<ArchivedPatchOutcome>(["succeeded", "unknown", "in-flight"]).has(mutationOutcome)
    ) {
      return true;
    }
    try {
      const result = await evaluateByValue<{
        ok?: boolean;
        status?: number;
        code?: string;
      }>(
        Runtime,
        `(() => {
          const state = window.__oracleArchivedConversationRecovery;
          if (
            !state ||
            state.version !== 2 ||
            state.owner !== ${jsString(recoveryOwner)} ||
            state.target !== ${jsString(targetApiUrl)}
          ) return { ok: false, code: "recovery-state-mismatch" };
          return typeof state.restoreArchivedConversation === "function"
            ? state.restoreArchivedConversation()
            : { ok: false, code: "restore-helper-unavailable" };
        })()`,
        "archive restore",
        true,
      );
      if (result?.ok === true) {
        archiveRestored = true;
        return true;
      }
    } catch {
      // Preserve the exact target when the conservative compensation cannot be verified.
    }
    preserveTargetOnFailure = true;
    return false;
  };
  const archiveRecoveryDetails = () => ({
    attempted: true,
    recovered: mutationOutcome === "succeeded",
    status: mutationOutcome === "succeeded" ? "recovered" : "not-needed",
    patchOutcome: mutationOutcome,
    archiveRestored,
    settingsUrl,
    ...(mutationStatus === undefined ? {} : { patchStatus: mutationStatus }),
  });
  const buildResidueError = (error: unknown, cause = error): BrowserAutomationError => {
    const details = error instanceof BrowserAutomationError ? error.details : undefined;
    return new BrowserAutomationError(
      error instanceof Error ? error.message : String(error),
      {
        ...(details ?? {}),
        stage: details?.stage ?? "chatgpt-export",
        code: details?.code ?? "archive-recovery-residue",
        archiveRecovery: archiveRecoveryDetails(),
        recoveryHandle: {
          transport: "cdp",
          ...(browserWSEndpoint ? { browserWSEndpoint } : {}),
          targetId,
          conversationUrl: targetUrl,
        },
      },
      cause,
    );
  };
  try {
    await Page.enable();
    await waitForDocument(Runtime, timeoutMs);
    const observed = await readChatGptIdentityDigests(Runtime);
    if (observed.accountDigest !== accountDigest || observed.workspaceDigest !== workspaceDigest) {
      throw new Error("Remote Chrome account or workspace identity changed before ChatGPT export.");
    }
    const recoveryHook = buildArchivedConversationRecoveryHook({
      targetUrl,
      accountDigest,
      workspaceDigest,
      owner: recoveryOwner,
    });
    recoveryHookInstalled = true;
    await Runtime.evaluate({
      expression: recoveryHook,
      awaitPromise: false,
      returnByValue: true,
    });
    recoveryRegistrationAttempted = true;
    recoveryScriptIdentifier = (
      await Page.addScriptToEvaluateOnNewDocument({ source: recoveryHook })
    ).identifier;
    await Page.navigate({ url: settingsUrl });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      state = await evaluateByValue<JsonRecord>(
        Runtime,
        "window.__oracleArchivedConversationRecovery || {}",
        "archive recovery",
      );
      updateMutationState(state);
      const stateBelongsToRun =
        state.target === targetApiUrl && state.version === 2 && state.owner === recoveryOwner;
      if (typeof state.target === "string" && !stateBelongsToRun) {
        throw new Error("Archived conversation recovery hook owner or version changed.");
      }
      if (state.status === "recovered") break;
      if (state.status === "failed") break;
      await delay(200);
    }
    updateMutationState(state);
    if (
      state.status !== "recovered" ||
      state.target !== targetApiUrl ||
      state.version !== 2 ||
      state.owner !== recoveryOwner
    ) {
      throw new Error(
        state.patchOutcome === "unknown"
          ? "Archived ChatGPT recovery PATCH outcome is unknown; exact-target compensation is required."
          : "Timed out recovering the archived ChatGPT conversation.",
      );
    }
    try {
      await Page.navigate({ url: targetUrl });
      const tabUrl = await waitForConversationUrl(Runtime, targetUrl, timeoutMs);
      await waitForDocument(Runtime, timeoutMs);
      await cleanupArchivedConversationRecovery(
        Runtime,
        Page,
        targetApiUrl,
        recoveryScriptIdentifier,
        recoveryOwner,
        recoveryRegistrationAttempted,
      );
      recoveryHookInstalled = false;
      recoveryScriptIdentifier = undefined;
      recoveryRegistrationAttempted = false;
      completed = true;
      return {
        client,
        targetId,
        tabUrl,
        recovery: {
          attempted: true,
          recovered: true,
          status: "recovered",
          settingsUrl,
          patchStatus: mutationStatus,
        },
        close,
      };
    } catch (error) {
      const compensated = await compensateArchiveMutation();
      if (!compensated) preserveTargetOnFailure = true;
      throw error;
    }
  } catch (error) {
    updateMutationState(state);
    if (!completed && mutationOutcome !== "not-started") {
      await compensateArchiveMutation();
    }
    if (preserveTargetOnFailure) {
      const residueError = buildResidueError(error);
      surfacedError = residueError;
      throw residueError;
    }
    surfacedError = error;
    throw error;
  } finally {
    try {
      if (recoveryHookInstalled || recoveryRegistrationAttempted) {
        try {
          await cleanupArchivedConversationRecovery(
            Runtime,
            Page,
            targetApiUrl,
            recoveryScriptIdentifier,
            recoveryOwner,
            recoveryRegistrationAttempted,
          );
          recoveryHookInstalled = false;
          recoveryScriptIdentifier = undefined;
          recoveryRegistrationAttempted = false;
        } catch (error) {
          preserveTargetOnFailure = true;
          finalCleanupError = error;
        }
      }
    } finally {
      if (!completed && !preserveTargetOnFailure) {
        try {
          await close();
        } catch (error) {
          preserveTargetOnFailure = true;
          finalCleanupError = error;
        }
      }
      if (preserveTargetOnFailure) {
        const residueError =
          surfacedError instanceof BrowserAutomationError && surfacedError.details?.recoveryHandle
            ? surfacedError
            : buildResidueError(
                surfacedError ?? new Error("Archived recovery left target residue."),
              );
        if (finalCleanupError !== undefined) {
          const details = (residueError.details ?? {}) as Record<string, unknown>;
          details.cleanupFailure =
            finalCleanupError instanceof BrowserAutomationError
              ? { message: finalCleanupError.message, details: finalCleanupError.details }
              : {
                  message:
                    finalCleanupError instanceof Error
                      ? finalCleanupError.message
                      : String(finalCleanupError),
                };
        }
        // oxlint-disable-next-line no-unsafe-finally -- cleanup residue must remain visible with its exact recovery handle.
        throw residueError;
      }
    }
  }
}

async function evaluateByValue<T>(
  Runtime: ChromeClient["Runtime"],
  expression: string,
  timeoutLabel = "Runtime.evaluate",
  awaitPromise = false,
): Promise<T> {
  const result = await Runtime.evaluate({
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`${timeoutLabel} failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result?.value as T;
}

function isMissingNewDocumentScriptError(error: unknown): boolean {
  const response = asRecord(asRecord(error).response);
  if (response.code === -32_000 && response.message === "Script not found") return true;
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = asRecord(JSON.parse(message));
    return parsed.code === -32_000 && parsed.message === "Script not found";
  } catch {
    return false;
  }
}

async function removeNewDocumentScript(
  Page: ChromeClient["Page"],
  identifier: string | undefined,
): Promise<boolean> {
  if (!identifier) throw new Error("new-document script identifier is unavailable");
  const remove = (
    Page as unknown as {
      removeScriptToEvaluateOnNewDocument?: (params: { identifier: string }) => Promise<void>;
    }
  ).removeScriptToEvaluateOnNewDocument;
  if (typeof remove !== "function") {
    throw new Error("removeScriptToEvaluateOnNewDocument is unavailable");
  }
  try {
    await remove.call(Page, { identifier });
  } catch (error) {
    if (!isMissingNewDocumentScriptError(error)) throw error;
  }
  return true;
}

type CleanupHookKind = "capture" | "archive-recovery";

function cleanupDisabledMarkerKey(kind: CleanupHookKind, targetApiUrl: string): string {
  const prefix =
    kind === "capture"
      ? "__oracleChatGptBackendCaptureDisabled:v2:"
      : "__oracleArchivedConversationRecoveryDisabled:v2:";
  return `${prefix}${targetApiUrl}`;
}
function cleanupLegacyDisabledMarkerKey(kind: CleanupHookKind, targetApiUrl: string): string {
  const prefix =
    kind === "capture"
      ? "__oracleChatGptBackendCaptureDisabled:"
      : "__oracleArchivedConversationRecoveryDisabled:";
  return `${prefix}${targetApiUrl}`;
}

async function armCleanupDisabledMarker(
  Runtime: ChromeClient["Runtime"],
  kind: CleanupHookKind,
  targetApiUrl: string,
  owner: string,
): Promise<{ owned: boolean; preExisting: boolean; foreignActive?: boolean }> {
  const key = cleanupDisabledMarkerKey(kind, targetApiUrl);
  const legacyKey = cleanupLegacyDisabledMarkerKey(kind, targetApiUrl);
  const stateExpression =
    kind === "capture"
      ? "window.__oracleChatGptBackendCapture"
      : "window.__oracleArchivedConversationRecovery";
  const result = await evaluateByValue<{
    owned?: boolean;
    preExisting?: boolean;
    foreignActive?: boolean;
    retained?: boolean;
  }>(
    Runtime,
    `(() => {
      const key = ${jsString(key)};
      const legacyKey = ${jsString(legacyKey)};
      const owner = ${jsString(owner)};
      try {
        const existing = sessionStorage.getItem(key);
        sessionStorage.setItem(legacyKey, "1");
        if (sessionStorage.getItem(legacyKey) !== "1") {
          return { owned: false, preExisting: true, retained: false };
        }
        const state = ${stateExpression};
        const sameOwnerActive = Boolean(
          state?.target === ${jsString(targetApiUrl)} &&
          state?.active &&
          state?.version === 2 &&
          state?.owner === owner
        );
        const foreignActive = Boolean(
          state?.target === ${jsString(targetApiUrl)} &&
          state?.active &&
          !sameOwnerActive
        );
        if (foreignActive) {
          return {
            owned: false,
            preExisting: existing !== null,
            foreignActive: true,
            retained: sessionStorage.getItem(key) === existing,
          };
        }
        if (existing !== null && existing !== owner && !sameOwnerActive) {
          return {
            owned: false,
            preExisting: true,
            retained: sessionStorage.getItem(key) === existing,
          };
        }
        sessionStorage.setItem(key, owner);
        return {
          owned: true,
          preExisting: existing !== null,
          retained: sessionStorage.getItem(key) === owner,
        };
      } catch {
        return { owned: false, preExisting: true, retained: false };
      }
    })()`,
    `${kind} cleanup fail-closed marker`,
  );
  if (result?.retained !== true) {
    throw new Error("ChatGPT cleanup fail-closed marker was not retained.");
  }
  return {
    owned: result.owned === true,
    preExisting: result.preExisting === true,
    foreignActive: result.foreignActive === true,
  };
}

async function clearCleanupDisabledMarker(
  Runtime: ChromeClient["Runtime"],
  kind: CleanupHookKind,
  targetApiUrl: string,
  owner: string,
): Promise<void> {
  const key = cleanupDisabledMarkerKey(kind, targetApiUrl);
  const cleared = await evaluateByValue<boolean>(
    Runtime,
    `(() => {
      const key = ${jsString(key)};
      const owner = ${jsString(owner)};
      try {
        if (sessionStorage.getItem(key) !== owner) return false;
        sessionStorage.removeItem(key);
        return sessionStorage.getItem(key) === null;
      } catch {
        return false;
      }
    })()`,
    `${kind} cleanup marker clear`,
  );
  if (cleared !== true) throw new Error("ChatGPT cleanup marker was not cleared.");
}

function recordCleanupFailure(failures: string[], failure: string): void {
  if (!failures.includes(failure)) failures.push(failure);
}
async function cleanupScopedBackendCapture(
  Runtime: ChromeClient["Runtime"],
  Page: ChromeClient["Page"],
  targetApiUrl: string,
  identifier: string | undefined,
  owner: string | undefined,
  registrationAttempted = identifier !== undefined,
): Promise<void> {
  const failures: string[] = [];
  const markerOwner = owner?.trim();
  if (!markerOwner) {
    try {
      await removeNewDocumentScript(Page, identifier);
    } catch {
      recordCleanupFailure(failures, "script removal");
    }
    recordCleanupFailure(failures, "hook owner");
    throw new BrowserAutomationError("ChatGPT capture cleanup failed.", {
      stage: "chatgpt-export",
      code: "capture-cleanup-failed",
      cleanup: failures,
    });
  }
  const markerKey = cleanupDisabledMarkerKey("capture", targetApiUrl);
  let marker: { owned: boolean; preExisting: boolean; foreignActive?: boolean } | undefined;
  let markerArmFailed = false;
  try {
    marker = await armCleanupDisabledMarker(Runtime, "capture", targetApiUrl, markerOwner);
  } catch {
    markerArmFailed = true;
  }

  const cleanupPage = async (
    allowOrphanCleanup: boolean,
    allowUnmarkedCleanup: boolean = false,
  ): Promise<{ ok: boolean; matched: boolean }> => {
    try {
      const result = await evaluateByValue<{
        markerOwned?: boolean;
        ownerMatched?: boolean;
        matched?: boolean;
        deactivated?: boolean;
        restoredFetch?: boolean;
        restoredXMLHttpRequest?: boolean;
        stateRemoved?: boolean;
        selectionRemoved?: boolean;
        storageRemoved?: boolean;
        payloadCleared?: boolean;
      } | null>(
        Runtime,
        `(() => {
          const target = ${jsString(targetApiUrl)};
          const markerKey = ${jsString(markerKey)};
          const markerOwner = ${jsString(markerOwner)};
          const allowOrphanCleanup = ${String(allowOrphanCleanup)};
          const allowUnmarkedCleanup = ${String(allowUnmarkedCleanup)};
          let markerValue = null;
          let markerReadable = false;
          try {
            markerValue = sessionStorage.getItem(markerKey);
            markerReadable = true;
          } catch {}
          const markerOwned = markerValue === markerOwner;
          const markerSatisfied =
            markerOwned || (allowUnmarkedCleanup && markerReadable && markerValue === null);
          if (!markerSatisfied) {
            return {
              markerOwned: false,
              ownerMatched: false,
              matched: false,
              deactivated: false,
              restoredFetch: false,
              restoredXMLHttpRequest: false,
              stateRemoved: false,
              selectionRemoved: false,
              storageRemoved: false,
              payloadCleared: false,
            };
          }
          const capture = window.__oracleChatGptBackendCapture;
          if (
            capture?.target === target &&
            (capture?.version !== 2 || capture?.owner !== markerOwner)
          ) {
            return {
              markerOwned: markerSatisfied,
              ownerMatched: false,
              matched: true,
              deactivated: false,
              restoredFetch: false,
              restoredXMLHttpRequest: false,
              stateRemoved: false,
              selectionRemoved: false,
              storageRemoved: false,
              payloadCleared: false,
            };
          }
          if (!capture || capture.target !== target) {
            const storageKey = "__oracleChatGptBackendCapture:" + target;
            const storageOwnerKey = "__oracleChatGptBackendCaptureOwner:" + target;
            const selection = window.__oracleChatGptBackendCaptureSelection;
            const selectionOwned =
              selection?.target === target &&
              selection?.capture?.version === 2 &&
              selection?.capture?.owner === markerOwner;
            let selectionRemoved = selection?.target !== target;
            let payloadCleared = selection?.target !== target;
            let storageRemoved = true;
            let storedPayload = null;
            let storedOwner = null;
            try {
              storedPayload = sessionStorage.getItem(storageKey);
              storedOwner = sessionStorage.getItem(storageOwnerKey);
            } catch {
              storageRemoved = false;
            }
            if (storedPayload !== null || storedOwner !== null) {
              storageRemoved = storedOwner === markerOwner;
            }
            if (!allowOrphanCleanup) {
              return {
                markerOwned: markerSatisfied,
                ownerMatched: true,
                matched: false,
                deactivated: true,
                restoredFetch: true,
                restoredXMLHttpRequest: true,
                stateRemoved: true,
                selectionRemoved,
                storageRemoved,
                payloadCleared,
              };
            }
            if (selection?.target === target) {
              if (!selectionOwned) {
                selectionRemoved = false;
                payloadCleared = false;
              } else {
                try {
                  if (selection && typeof selection === "object" && "text" in selection) {
                    selection.text = "";
                    payloadCleared = selection.text === "";
                  }
                } catch {
                  payloadCleared = false;
                }
                try {
                  delete window.__oracleChatGptBackendCaptureSelection;
                } catch {}
                selectionRemoved = window.__oracleChatGptBackendCaptureSelection?.target !== target;
              }
            }
            if (storedOwner === markerOwner) {
              try {
                sessionStorage.removeItem(storageKey);
                sessionStorage.removeItem(storageOwnerKey);
                storageRemoved =
                  sessionStorage.getItem(storageKey) === null &&
                  sessionStorage.getItem(storageOwnerKey) === null;
              } catch {
                storageRemoved = false;
              }
            }
            return {
              markerOwned: markerSatisfied,
              ownerMatched: true,
              matched: false,
              deactivated: true,
              restoredFetch: true,
              restoredXMLHttpRequest: true,
              stateRemoved: true,
              selectionRemoved,
              storageRemoved,
              payloadCleared,
            };
          }
          const cleanup = capture.cleanup?.() || {};
          return {
            markerOwned: markerSatisfied,
            ownerMatched:
              capture.version === 2 &&
              capture.owner === markerOwner &&
              cleanup.ownerMatched !== false,
            matched: true,
            ...cleanup,
          };
        })()`,
        "capture cleanup",
      );
      const ok = Boolean(
        result &&
        result.markerOwned === true &&
        result.ownerMatched === true &&
        result.deactivated === true &&
        result.restoredFetch === true &&
        result.restoredXMLHttpRequest === true &&
        result.stateRemoved === true &&
        result.selectionRemoved === true &&
        result.storageRemoved === true &&
        result.payloadCleared === true,
      );
      return { ok, matched: result?.matched === true };
    } catch {
      return { ok: false, matched: false };
    }
  };

  let pageResult: { ok: boolean; matched: boolean } | undefined;
  let registrationRemoved = !registrationAttempted;
  if (identifier !== undefined) {
    try {
      registrationRemoved = await removeNewDocumentScript(Page, identifier);
    } catch {
      recordCleanupFailure(failures, "script removal");
    }
  } else if (registrationAttempted) {
    recordCleanupFailure(failures, "script registration unverified");
  }
  try {
    marker = await armCleanupDisabledMarker(Runtime, "capture", targetApiUrl, markerOwner);
    markerArmFailed = false;
  } catch {
    marker = undefined;
    markerArmFailed = true;
  }
  if (marker?.foreignActive === true && registrationRemoved) return;
  if (markerArmFailed) recordCleanupFailure(failures, "fail-closed marker");
  if (marker?.preExisting === true && marker.owned !== true) {
    recordCleanupFailure(failures, "pre-existing fail-closed marker");
  }
  if (marker?.owned === true) {
    pageResult = await cleanupPage(registrationRemoved);
  } else if (marker === undefined && registrationRemoved) {
    pageResult = await cleanupPage(true, true);
  }

  const pageFailure = !pageResult?.ok || (!pageResult.matched && !registrationRemoved);
  if (pageFailure) recordCleanupFailure(failures, "page cleanup");
  const matchingCleanup =
    pageResult?.ok === true && (pageResult.matched || (!pageResult.matched && registrationRemoved));
  if (failures.length === 0 && registrationRemoved && matchingCleanup && marker?.owned === true) {
    try {
      await clearCleanupDisabledMarker(Runtime, "capture", targetApiUrl, markerOwner);
    } catch {
      recordCleanupFailure(failures, "fail-closed marker");
    }
  }
  if (failures.length > 0) {
    let containmentResult: { ok: boolean; matched: boolean } | undefined;
    try {
      marker = await armCleanupDisabledMarker(Runtime, "capture", targetApiUrl, markerOwner);
      if (marker.owned) {
        containmentResult = await cleanupPage(registrationRemoved);
        if (!containmentResult.ok) recordCleanupFailure(failures, "page cleanup");
      } else if (marker.foreignActive && registrationRemoved) {
        return;
      } else if (marker.preExisting && !marker.owned) {
        recordCleanupFailure(failures, "pre-existing fail-closed marker");
      }
    } catch {
      recordCleanupFailure(failures, "fail-closed marker");
      if (marker === undefined && registrationRemoved) {
        try {
          containmentResult = await cleanupPage(true, true);
          if (!containmentResult.ok) recordCleanupFailure(failures, "page cleanup");
        } catch {
          recordCleanupFailure(failures, "page cleanup");
        }
      }
    }
    if (containmentResult?.ok === true && pageFailure) {
      const pageIndex = failures.indexOf("page cleanup");
      if (pageIndex >= 0) failures.splice(pageIndex, 1);
    }
    if (
      failures.every((failure) => failure === "fail-closed marker") &&
      containmentResult?.ok === true &&
      registrationRemoved &&
      marker?.owned === true
    ) {
      try {
        await clearCleanupDisabledMarker(Runtime, "capture", targetApiUrl, markerOwner);
        failures.length = 0;
      } catch {}
    }
    if (failures.length === 0) return;
    throw new BrowserAutomationError("ChatGPT capture cleanup failed.", {
      stage: "chatgpt-export",
      code: "capture-cleanup-failed",
      cleanup: failures,
    });
  }
}
export async function cleanupScopedBackendCaptureForTest(
  Runtime: ChromeClient["Runtime"],
  Page: ChromeClient["Page"],
  targetApiUrl: string,
  identifier: string | undefined,
  owner: string | undefined,
  registrationAttempted = identifier !== undefined,
): Promise<void> {
  await cleanupScopedBackendCapture(
    Runtime,
    Page,
    targetApiUrl,
    identifier,
    owner,
    registrationAttempted,
  );
}

async function cleanupArchivedConversationRecovery(
  Runtime: ChromeClient["Runtime"],
  Page: ChromeClient["Page"],
  targetApiUrl: string,
  identifier: string | undefined,
  owner: string | undefined,
  registrationAttempted = identifier !== undefined,
): Promise<void> {
  const failures: string[] = [];
  const markerOwner = owner?.trim();
  if (!markerOwner) {
    if (identifier !== undefined) {
      try {
        await removeNewDocumentScript(Page, identifier);
      } catch {
        recordCleanupFailure(failures, "script removal");
      }
    }
    recordCleanupFailure(failures, "hook owner");
    throw new BrowserAutomationError("Archived ChatGPT recovery cleanup failed.", {
      stage: "chatgpt-export",
      code: "archive-recovery-cleanup-failed",
      cleanup: failures,
    });
  }
  const markerKey = cleanupDisabledMarkerKey("archive-recovery", targetApiUrl);
  let marker: { owned: boolean; preExisting: boolean; foreignActive?: boolean } | undefined;
  let markerArmFailed = false;
  try {
    marker = await armCleanupDisabledMarker(Runtime, "archive-recovery", targetApiUrl, markerOwner);
  } catch {
    markerArmFailed = true;
  }

  const cleanupPage = async (
    allowOrphanCleanup: boolean,
    allowUnmarkedCleanup: boolean = false,
  ): Promise<{ ok: boolean; matched: boolean }> => {
    try {
      let result: {
        markerOwned?: boolean;
        ownerMatched?: boolean;
        matched?: boolean;
        pending?: boolean;
        deactivated?: boolean;
        restoredFetch?: boolean;
        stateRemoved?: boolean;
      } | null = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        result = await evaluateByValue<{
          markerOwned?: boolean;
          ownerMatched?: boolean;
          matched?: boolean;
          pending?: boolean;
          deactivated?: boolean;
          restoredFetch?: boolean;
          stateRemoved?: boolean;
        } | null>(
          Runtime,
          `(() => {
            const target = ${jsString(targetApiUrl)};
            const markerKey = ${jsString(markerKey)};
            const markerOwner = ${jsString(markerOwner)};
            const allowOrphanCleanup = ${String(allowOrphanCleanup)};
            const allowUnmarkedCleanup = ${String(allowUnmarkedCleanup)};
            let markerValue = null;
            let markerReadable = false;
            try {
              markerValue = sessionStorage.getItem(markerKey);
              markerReadable = true;
            } catch {}
            const markerOwned = markerValue === markerOwner;
            const markerSatisfied =
              markerOwned || (allowUnmarkedCleanup && markerReadable && markerValue === null);
            if (!markerSatisfied) {
              return {
                markerOwned: false,
                ownerMatched: false,
                matched: false,
                pending: false,
                deactivated: false,
                restoredFetch: false,
                stateRemoved: false,
              };
            }
            const state = window.__oracleArchivedConversationRecovery;
            if (
              state?.target === target &&
              (state?.version !== 2 || state?.owner !== markerOwner)
            ) {
              return {
                markerOwned: markerSatisfied,
                ownerMatched: false,
                matched: true,
                pending: false,
                deactivated: false,
                restoredFetch: false,
                stateRemoved: false,
              };
            }
            if (!state || state.target !== target) {
              return {
                markerOwned: markerSatisfied,
                ownerMatched: true,
                matched: false,
                pending: false,
                deactivated: true,
                restoredFetch: true,
                stateRemoved: true,
              };
            }
            const cleanup = state.cleanup?.() || {};
            return {
              markerOwned: markerSatisfied,
              ownerMatched:
                state.version === 2 && state.owner === markerOwner && cleanup.ownerMatched !== false,
              matched: true,
              ...cleanup,
            };
          })()`,
          "archive recovery cleanup",
        );
        if (!result?.pending) break;
        await delay(50);
      }
      const ok = Boolean(
        result &&
        result.markerOwned === true &&
        result.ownerMatched === true &&
        result.pending !== true &&
        result.deactivated === true &&
        result.restoredFetch === true &&
        result.stateRemoved === true &&
        (result.matched === true || allowOrphanCleanup),
      );
      return { ok, matched: result?.matched === true };
    } catch {
      return { ok: false, matched: false };
    }
  };

  let pageResult: { ok: boolean; matched: boolean } | undefined;
  let registrationRemoved = !registrationAttempted;
  if (identifier !== undefined) {
    try {
      registrationRemoved = await removeNewDocumentScript(Page, identifier);
    } catch {
      recordCleanupFailure(failures, "script removal");
    }
  } else if (registrationAttempted) {
    recordCleanupFailure(failures, "script registration unverified");
  }
  try {
    marker = await armCleanupDisabledMarker(Runtime, "archive-recovery", targetApiUrl, markerOwner);
    markerArmFailed = false;
  } catch {
    marker = undefined;
    markerArmFailed = true;
  }
  if (marker?.foreignActive === true && registrationRemoved) return;
  if (markerArmFailed) recordCleanupFailure(failures, "fail-closed marker");
  if (marker?.preExisting === true && marker.owned !== true) {
    recordCleanupFailure(failures, "pre-existing fail-closed marker");
  }
  if (marker?.owned === true) {
    pageResult = await cleanupPage(registrationRemoved);
  } else if (marker === undefined && registrationRemoved) {
    pageResult = await cleanupPage(true, true);
  }

  const pageFailure = !pageResult?.ok || (!pageResult.matched && !registrationRemoved);
  if (pageFailure) recordCleanupFailure(failures, "page cleanup");
  if (failures.length === 0 && registrationRemoved && marker?.owned === true && pageResult?.ok) {
    try {
      await clearCleanupDisabledMarker(Runtime, "archive-recovery", targetApiUrl, markerOwner);
    } catch {
      recordCleanupFailure(failures, "fail-closed marker");
    }
  }
  if (failures.length > 0) {
    let containmentResult: { ok: boolean; matched: boolean } | undefined;
    try {
      marker = await armCleanupDisabledMarker(
        Runtime,
        "archive-recovery",
        targetApiUrl,
        markerOwner,
      );
      if (marker.owned) {
        containmentResult = await cleanupPage(registrationRemoved);
        if (!containmentResult.ok) recordCleanupFailure(failures, "page cleanup");
      } else if (marker.foreignActive && registrationRemoved) {
        return;
      } else if (marker.preExisting && !marker.owned) {
        recordCleanupFailure(failures, "pre-existing fail-closed marker");
      }
    } catch {
      recordCleanupFailure(failures, "fail-closed marker");
      if (marker === undefined && registrationRemoved) {
        try {
          containmentResult = await cleanupPage(true, true);
          if (!containmentResult.ok) recordCleanupFailure(failures, "page cleanup");
        } catch {
          recordCleanupFailure(failures, "page cleanup");
        }
      }
    }
    if (containmentResult?.ok === true && pageFailure) {
      const pageIndex = failures.indexOf("page cleanup");
      if (pageIndex >= 0) failures.splice(pageIndex, 1);
    }
    if (
      failures.every((failure) => failure === "fail-closed marker") &&
      containmentResult?.ok === true &&
      registrationRemoved &&
      marker?.owned === true
    ) {
      try {
        await clearCleanupDisabledMarker(Runtime, "archive-recovery", targetApiUrl, markerOwner);
        failures.length = 0;
      } catch {}
    }
    if (failures.length === 0) return;
    throw new BrowserAutomationError("Archived ChatGPT recovery cleanup failed.", {
      stage: "chatgpt-export",
      code: "archive-recovery-cleanup-failed",
      cleanup: failures,
    });
  }
}

export async function cleanupArchivedConversationRecoveryForTest(
  Runtime: ChromeClient["Runtime"],
  Page: ChromeClient["Page"],
  targetApiUrl: string,
  identifier: string | undefined,
  owner: string | undefined,
  registrationAttempted = identifier !== undefined,
): Promise<void> {
  await cleanupArchivedConversationRecovery(
    Runtime,
    Page,
    targetApiUrl,
    identifier,
    owner,
    registrationAttempted,
  );
}

interface CapturePollOptions {
  passiveWindowMs?: number;
  passiveDeadline?: number;
  requestFallback?: (remainingMs: number) => Promise<boolean>;
  expectedOwner?: string;
}

async function pollCaptureWithEvaluator(
  evaluate: EvaluateExpression,
  targetApiUrl: string,
  timeoutMs: number,
  options: CapturePollOptions = {},
): Promise<CapturePollResult> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const passiveDeadline = options.requestFallback
    ? Math.min(
        deadline,
        options.passiveDeadline ??
          startedAt + Math.min(timeoutMs, Math.max(0, options.passiveWindowMs ?? 0)),
      )
    : Number.POSITIVE_INFINITY;
  let fallbackRequested = false;
  let last: CapturePollResult = {};
  const timeoutError = () => {
    const requests = last.requests ?? { started: 0, pending: 0, completed: 0 };
    return new Error(
      `Timed out waiting for backend conversation capture ` +
        `(started=${requests.started}, pending=${requests.pending}, completed=${requests.completed}).`,
    );
  };
  const runBeforeDeadline = async <T>(
    operation: (remainingMs: number) => Promise<T>,
  ): Promise<T> => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(timeoutError()), remainingMs);
      });
      const result = await Promise.race([timeout, operation(remainingMs)]);
      if (Date.now() >= deadline) throw timeoutError();
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const expression = `
(() => {
  const target = ${jsString(targetApiUrl)};
  const expectedConversationId = target.slice(target.lastIndexOf("/") + 1);
  const isApprovedText = (value) => {
    try {
      return JSON.parse(String(value || ""))?.conversation_id === expectedConversationId;
    } catch {
      return false;
    }
  };
  const capture = window.__oracleChatGptBackendCapture;
  const expectedOwner = ${jsString(options.expectedOwner ?? "")};
  const ownerMismatch = Boolean(
    expectedOwner &&
    capture?.target === target &&
    (capture?.version !== 2 || capture?.owner !== expectedOwner),
  );
  const hits = ownerMismatch ? [] : (capture?.hits || []);
  const match = hits.find((hit) =>
    hit.url === target &&
    hit.status === 200 &&
    isApprovedText(hit.text)
  );
  const requests = ownerMismatch ? {} : (capture?.requests || {});
  return {
    ownerMatched: !ownerMismatch,
    hit: match ? {
      kind: match.kind,
      url: target,
      status: match.status,
      ok: match.ok,
      contentType: match.contentType,
      chars: String(match.text || "").length
    } : null,
    requests: {
      started: Number(requests.started || 0),
      pending: Number(requests.pending || 0),
      completed: Number(requests.completed || 0)
    }
  };
})()
`;
  while (Date.now() < deadline) {
    last = await runBeforeDeadline(() => evaluate<CapturePollResult>(expression, "capture poll"));
    if (last.ownerMatched === false) {
      throw new Error("ChatGPT capture hook owner or version changed before export.");
    }
    if (Date.now() >= deadline) break;
    if (last.hit) return last;

    const now = Date.now();
    const targetRequestPending = (last.requests?.pending ?? 0) > 0;
    if (
      options.requestFallback &&
      !fallbackRequested &&
      !targetRequestPending &&
      now >= passiveDeadline
    ) {
      fallbackRequested = await runBeforeDeadline((remainingMs) =>
        options.requestFallback!(remainingMs),
      );
      continue;
    }

    const nextBoundary =
      options.requestFallback && !fallbackRequested && !targetRequestPending
        ? Math.min(deadline, passiveDeadline)
        : deadline;
    await runBeforeDeadline((remainingMs) =>
      delay(Math.min(1_000, Math.max(1, nextBoundary - now), remainingMs)),
    );
  }
  throw timeoutError();
}

export async function pollCaptureWithPassiveFallbackForTest(
  evaluate: (expression: string, timeoutLabel?: string) => Promise<CapturePollResult>,
  targetApiUrl: string,
  timeoutMs: number,
  passiveWindowMs: number,
  requestFallback: (remainingMs: number) => Promise<boolean>,
  passiveDeadline?: number,
  expectedOwner?: string,
): Promise<CapturePollResult> {
  return pollCaptureWithEvaluator(
    <T>(expression: string, timeoutLabel?: string) =>
      evaluate(expression, timeoutLabel) as Promise<T>,
    targetApiUrl,
    timeoutMs,
    { passiveWindowMs, passiveDeadline, requestFallback, expectedOwner },
  );
}

async function pollCapture(
  Runtime: ChromeClient["Runtime"],
  targetApiUrl: string,
  timeoutMs: number,
  options: CapturePollOptions = {},
): Promise<CapturePollResult> {
  return pollCaptureWithEvaluator(
    <T>(expression: string, timeoutLabel?: string) =>
      evaluateByValue<T>(Runtime, expression, timeoutLabel),
    targetApiUrl,
    timeoutMs,
    options,
  );
}

export async function retrieveCapturedTextWithEvaluator(
  evaluate: EvaluateExpression,
  targetApiUrl: string,
  chars: number,
  chunkSize: number,
  deadline?: number,
  expectedOwner?: string,
  affinityCheck?: (deadline: number) => Promise<void>,
): Promise<string> {
  const absoluteDeadline = deadline ?? Date.now() + 15_000;
  const parts: string[] = [];
  let selectionReady = false;
  for (let start = 0; start < chars; start += chunkSize) {
    const end = Math.min(start + chunkSize, chars);
    const chunkDeadline = Math.min(absoluteDeadline, Date.now() + 15_000);
    if (affinityCheck) {
      await runBeforeCaptureDeadline(chunkDeadline, () => affinityCheck(chunkDeadline));
    }
    const expression = `
(() => {
  const target = ${jsString(targetApiUrl)};
  const capture = window.__oracleChatGptBackendCapture;
  const expectedOwner = ${jsString(expectedOwner ?? "")};
  const ownerMismatch = Boolean(
    expectedOwner &&
    (capture?.target !== target || capture?.version !== 2 || capture?.owner !== expectedOwner),
  );
  if (ownerMismatch) return null;
  const existingSelection = window.__oracleChatGptBackendCaptureSelection;
  const selectionBelongsToCapture = Boolean(
    existingSelection?.target === target && existingSelection?.capture === capture,
  );
  const selectionOwnerMatches = Boolean(
    existingSelection?.target === target &&
    existingSelection?.capture?.target === target &&
    existingSelection?.capture?.version === 2 &&
    existingSelection?.capture?.owner === expectedOwner,
  );
  if (expectedOwner && existingSelection?.target === target && !selectionOwnerMatches) return null;
  const selected = ${selectionReady ? "existingSelection" : "selectionBelongsToCapture ? existingSelection : null"};
  if (
    selected?.target === target &&
    selected?.capture === capture &&
    typeof selected?.text === "string"
  ) return selected.text.slice(${start}, ${end});
  const expectedConversationId = target.slice(target.lastIndexOf("/") + 1);
  const isApprovedText = (value) => {
    try {
      return JSON.parse(String(value || ""))?.conversation_id === expectedConversationId;
    } catch {
      return false;
    }
  };
  const hits = capture?.hits || [];
  const hit = hits.find((item) => item.url === target && item.status === 200 && isApprovedText(item.text));
  const persistedOwner = sessionStorage.getItem("__oracleChatGptBackendCaptureOwner:" + target);
  const persisted =
    persistedOwner === capture?.owner
      ? sessionStorage.getItem("__oracleChatGptBackendCapture:" + target)
      : null;
  const text = hit ? String(hit.text) : (isApprovedText(persisted) ? persisted : null);
  if (!text) return null;
  window.__oracleChatGptBackendCaptureSelection = {
    target,
    capture,
    owner: capture?.owner,
    text,
  };
  return text.slice(${start}, ${end});
})()
`;
    let part: string | null = null;
    while (Date.now() < chunkDeadline) {
      part = await runBeforeCaptureDeadline(chunkDeadline, () =>
        evaluate<string | null>(expression, "capture chunk"),
      );
      if (typeof part === "string") break;
      await runBeforeCaptureDeadline(chunkDeadline, (remainingMs) =>
        delay(Math.min(250, remainingMs)),
      );
    }
    if (typeof part !== "string") {
      throw new Error(`Missing captured text chunk ${start}:${end}`);
    }
    if (affinityCheck) {
      await runBeforeCaptureDeadline(chunkDeadline, () => affinityCheck(chunkDeadline));
    }
    selectionReady = true;
    parts.push(part);
  }
  return parts.join("");
}

async function retrieveCapturedText(
  Runtime: ChromeClient["Runtime"],
  targetApiUrl: string,
  chars: number,
  chunkSize: number,
  deadline?: number,
  expectedOwner?: string,
  affinityCheck?: (deadline: number) => Promise<void>,
): Promise<string> {
  return retrieveCapturedTextWithEvaluator(
    <T>(expression: string, timeoutLabel?: string) =>
      evaluateByValue<T>(Runtime, expression, timeoutLabel),
    targetApiUrl,
    chars,
    chunkSize,
    deadline,
    expectedOwner,
    affinityCheck,
  );
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function pathFromMapping(
  mapping: Record<string, BackendNode>,
  currentNode: string | undefined,
): string[] {
  let nodeId: string | undefined = currentNode;
  const out: string[] = [];
  const seen = new Set<string>();
  while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
    seen.add(nodeId);
    out.push(nodeId);
    const parent = mapping[nodeId]?.parent;
    nodeId = typeof parent === "string" ? parent : undefined;
  }
  const reversed: string[] = [];
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const nodeId = out[index];
    if (nodeId) {
      reversed.push(nodeId);
    }
  }
  return reversed;
}

function branchPathFromMapping(
  mapping: Record<string, BackendNode>,
  currentNode: string | undefined,
  affinity?: ChatGptExportTurnAffinity,
): string[] {
  if (!affinity) return pathFromMapping(mapping, currentNode);
  const assistantNodes = Object.entries(mapping).filter(
    ([nodeId, node]) =>
      nodeId === affinity.assistantMessageId || node.message?.id === affinity.assistantMessageId,
  );
  if (assistantNodes.length !== 1) {
    throw new Error("Stored assistant branch is unavailable or ambiguous in the captured payload.");
  }
  const [assistantNodeId, assistantNode] = assistantNodes[0] as [string, BackendNode];
  if (assistantNode.message?.author?.role !== "assistant") {
    throw new Error("Stored assistant branch does not identify an assistant message.");
  }
  const path = pathFromMapping(mapping, assistantNodeId);
  const promptMatches = path.filter((nodeId) => {
    const node = mapping[nodeId];
    return nodeId === affinity.promptMessageId || node?.message?.id === affinity.promptMessageId;
  });
  if (promptMatches.length !== 1) {
    throw new Error("Stored prompt message is not the unique ancestor of the assistant branch.");
  }
  const promptNode = mapping[promptMatches[0] as string];
  if (promptNode?.message?.author?.role !== "user") {
    throw new Error("Stored prompt branch does not identify a user message.");
  }
  return path;
}

export function contentToText(content: JsonRecord): string {
  const contentType = String(content.content_type ?? "");
  if (contentType === "text") {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    return parts
      .map((part) => (typeof part === "string" ? part : JSON.stringify(part, null, 2)))
      .join("\n")
      .trim();
  }
  if (contentType === "code" || contentType === "execution_output") {
    return String(content.text ?? "").trim();
  }
  if (contentType === "reasoning_recap") {
    const value = content.content;
    return typeof value === "string" ? value.trim() : JSON.stringify(value ?? content, null, 2);
  }
  if (contentType === "thoughts") {
    return JSON.stringify(content.thoughts ?? content, null, 2).trim();
  }
  if (contentType === "tether_browsing_display") {
    return JSON.stringify(
      {
        summary: content.summary,
        result: content.result,
        assets: content.assets,
        tether_id: content.tether_id,
      },
      null,
      2,
    ).trim();
  }
  if (contentType === "model_editable_context") {
    return JSON.stringify(content, null, 2).trim();
  }
  return JSON.stringify(content, null, 2).trim();
}

function attachmentRecords(metadata: JsonRecord): JsonRecord[] {
  const raw = Array.isArray(metadata.attachments) ? metadata.attachments : [];
  return raw.flatMap((entry) => {
    const attachment = asRecord(entry);
    if (Object.keys(attachment).length === 0) {
      return [];
    }
    return [
      {
        label:
          attachment.name ??
          attachment.file_name ??
          attachment.id ??
          attachment.file_id ??
          "attachment",
        url: attachment.download_url ?? attachment.url ?? "",
        content_type: attachment.mime_type ?? attachment.content_type,
        source: "backend_metadata",
      },
    ];
  });
}

export function backendToPayload(
  backend: BackendConversation,
  targetUrl: string,
  rawSha256: string,
  rawBytes: number,
  turnAffinity?: ChatGptExportTurnAffinity,
): JsonRecord {
  const mapping = backend.mapping ?? {};
  const currentPath = branchPathFromMapping(mapping, backend.current_node, turnAffinity);
  const turns: JsonRecord[] = [];
  currentPath.forEach((nodeId, ordinal) => {
    const node = mapping[nodeId] ?? {};
    const message = node.message;
    if (!message) {
      return;
    }
    const author = message.author ?? {};
    const content = asRecord(message.content);
    const metadata = asRecord(message.metadata);
    const text = contentToText(content);
    turns.push({
      ordinal,
      role: author.role ?? "unknown",
      name: author.name,
      turn_id: nodeId,
      message_id: message.id,
      parent: node.parent,
      children: node.children ?? [],
      create_time: message.create_time,
      update_time: message.update_time,
      status: message.status,
      channel: message.channel,
      recipient: message.recipient,
      content_type: content.content_type,
      text,
      content,
      metadata,
      attachments: attachmentRecords(metadata),
      visible_status: [],
      extraction_status: "captured_backend_json",
      source: "backend-fetch-capture",
      text_length: text.length,
    });
  });
  const roleValues = new Set(turns.map((turn) => String(turn.role ?? "unknown")));
  const contentTypeValues = new Set(turns.map((turn) => String(turn.content_type ?? "unknown")));
  const stats = {
    turn_count: turns.length,
    user_turns: turns.filter((turn) => turn.role === "user").length,
    assistant_turns: turns.filter((turn) => turn.role === "assistant").length,
    tool_turns: turns.filter((turn) => turn.role === "tool").length,
    system_turns: turns.filter((turn) => turn.role === "system").length,
    mapping_node_count: Object.keys(mapping).length,
    current_path_node_count: currentPath.length,
    content_types: Object.fromEntries(
      [...contentTypeValues]
        .sort()
        .map((value) => [
          value,
          turns.filter((turn) => String(turn.content_type ?? "unknown") === value).length,
        ]),
    ),
    roles: Object.fromEntries(
      [...roleValues]
        .sort()
        .map((value) => [
          value,
          turns.filter((turn) => String(turn.role ?? "unknown") === value).length,
        ]),
    ),
    asset_candidates: turns.reduce(
      (count, turn) => count + (Array.isArray(turn.attachments) ? turn.attachments.length : 0),
      0,
    ),
    downloaded_assets: 0,
  };
  const expectedConversationId = conversationIdFromChatGptUrl(targetUrl);
  return {
    schema_version: "oracle.chatgpt-conversation-export.v1",
    exported_at: new Date().toISOString(),
    target_url: targetUrl,
    final_url: targetUrl,
    title: backend.title,
    conversation_id: backend.conversation_id,
    expected_conversation_id: expectedConversationId,
    scope_ok: backend.conversation_id === expectedConversationId,
    branch_affinity: turnAffinity
      ? {
          prompt_message_id: turnAffinity.promptMessageId,
          assistant_message_id: turnAffinity.assistantMessageId,
          verified: true,
        }
      : undefined,
    extraction_method: "scoped-backend-response-capture-in-page",
    limitations: [
      "Captures ChatGPT backend conversation JSON only for the exact approved conversation, using passive page-load interception or a route-and-identity-verified in-page request.",
      "Does not read browser cookies, localStorage, profile stores, or unrelated conversation history.",
      "Includes backend-only nodes such as tool events, thoughts, reasoning recaps, and hidden/system messages when present in the conversation payload.",
      "Does not claim real-world authorship or content beyond the captured ChatGPT backend payload.",
    ],
    backend_probe: {
      attempted: true,
      method: "scoped_page_context_capture",
      status: "captured",
      raw_backend_sha256: rawSha256,
      raw_backend_size_bytes: rawBytes,
      mapping_count: Object.keys(mapping).length,
      current_path_node_count: currentPath.length,
    },
    stats,
    turns,
    asset_candidates: turns.flatMap((turn) =>
      Array.isArray(turn.attachments) ? turn.attachments : [],
    ),
    downloaded_assets: [],
    backend_conversation_top_level_keys: Object.keys(backend),
    raw_backend_sha256: rawSha256,
  };
}

function markdownForPayload(payload: JsonRecord): string {
  const turns = Array.isArray(payload.turns) ? (payload.turns as JsonRecord[]) : [];
  const lines: string[] = [
    "# ChatGPT Conversation Export",
    "",
    `- Target URL: ${payload.target_url ?? ""}`,
    `- Conversation ID: ${payload.conversation_id ?? ""}`,
    `- Title: ${payload.title ?? ""}`,
    `- Exported at: ${payload.exported_at ?? ""}`,
    `- Extraction method: ${payload.extraction_method ?? ""}`,
    `- Raw backend SHA-256: ${payload.raw_backend_sha256 ?? ""}`,
    "",
    "## Non-Claims",
    "",
    "- This export is scoped to the explicitly approved conversation URL.",
    "- It does not read cookies, localStorage, browser profiles, or unrelated ChatGPT history.",
    "- It does not prove real-world authorship beyond the captured ChatGPT backend payload.",
    "",
    "## Turns",
    "",
  ];
  for (const turn of turns) {
    const ordinal = String(turn.ordinal ?? "").padStart(4, "0");
    lines.push(
      `### ${ordinal} ${turn.role ?? "unknown"} / ${turn.content_type ?? "unknown"}`,
      "",
      `- Turn ID: ${turn.turn_id ?? ""}`,
      `- Message ID: ${turn.message_id ?? ""}`,
      `- Channel: ${turn.channel ?? ""}`,
      `- Recipient: ${turn.recipient ?? ""}`,
      "",
      "```text",
      String(turn.text ?? ""),
      "```",
      "",
    );
  }
  return lines.join("\n");
}

const PRIVATE_BUNDLE_DIRECTORY_MODE = 0o700;
const PRIVATE_BUNDLE_FILE_MODE = 0o600;
const PRIVATE_BUNDLE_FILE_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0);

async function writePrivateBundleFile(filePath: string, contents: string): Promise<void> {
  const handle = await fs.open(filePath, PRIVATE_BUNDLE_FILE_FLAGS, PRIVATE_BUNDLE_FILE_MODE);
  try {
    if (process.platform !== "win32") {
      await handle.chmod(PRIVATE_BUNDLE_FILE_MODE);
    }
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writePrivateBundleFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function scanTextForSecretLikeMarkers(
  relativePath: string,
  text: string,
): { findings: JsonRecord[]; warnings: string[] } {
  const findings = SECRET_PATTERNS.flatMap(({ label, pattern }) =>
    pattern.test(text) ? [{ path: relativePath, marker: label }] : [],
  );
  const warnings = SECRET_MARKER_MENTIONS.flatMap((marker) =>
    text.includes(marker) ? [`marker mention present in ${relativePath}: ${marker}`] : [],
  );
  return { findings, warnings };
}

async function buildRedactionReport(outDir: string, files: string[]): Promise<JsonRecord> {
  const findings: JsonRecord[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    const absolute = path.join(outDir, file);
    const text = await fs.readFile(absolute, "utf8");
    const scan = scanTextForSecretLikeMarkers(file, text);
    findings.push(...scan.findings);
    warnings.push(...scan.warnings);
  }
  return {
    schema_version: "oracle.chatgpt-conversation-export.redaction-report.v1",
    created_at: new Date().toISOString(),
    ok: findings.length === 0,
    scanned_files: files,
    findings,
    warnings,
    non_claims: [
      "This scan checks exported bundle text for common secret-like markers.",
      "It does not inspect browser cookies, localStorage, profile stores, or unrelated files.",
    ],
  };
}

async function writeSha256Sums(outDir: string, files: string[]): Promise<string> {
  const lines: string[] = [];
  for (const file of files) {
    const absolute = path.join(outDir, file);
    lines.push(`${await sha256File(absolute)}  ${file}`);
  }
  const sumsPath = path.join(outDir, "SHA256SUMS.txt");
  await writePrivateBundleFile(sumsPath, `${lines.join("\n")}\n`);
  return sumsPath;
}

async function writeBundle({
  outDir,
  rawText,
  payload,
  captureInfo,
}: {
  outDir: string;
  rawText: string;
  payload: JsonRecord;
  captureInfo: JsonRecord;
}): Promise<{
  rawBackendPath: string;
  payloadPath: string;
  markdownPath: string;
  manifestPath: string;
  captureInfoPath: string;
  sha256SumsPath: string;
}> {
  await fs.mkdir(outDir, { recursive: true, mode: PRIVATE_BUNDLE_DIRECTORY_MODE });
  if (process.platform !== "win32") {
    await fs.chmod(outDir, PRIVATE_BUNDLE_DIRECTORY_MODE);
  }
  const rawBackendPath = path.join(outDir, "backend-conversation.json");
  const conversationPath = path.join(outDir, "conversation.json");
  const payloadPath = path.join(outDir, "payload.json");
  const markdownPath = path.join(outDir, "conversation.md");
  const manifestPath = path.join(outDir, "manifest.json");
  const captureInfoPath = path.join(outDir, "backend-capture-info.json");
  const redactionReportPath = path.join(outDir, "redaction-report.json");
  const stats = asRecord(payload.stats);
  const files = [
    "backend-conversation.json",
    "backend-capture-info.json",
    "conversation.json",
    "payload.json",
    "conversation.md",
    "manifest.json",
    "redaction-report.json",
  ];
  await writePrivateBundleFile(rawBackendPath, rawText);
  await writeJson(conversationPath, payload);
  await writeJson(payloadPath, payload);
  await writePrivateBundleFile(markdownPath, markdownForPayload(payload));
  await writeJson(captureInfoPath, captureInfo);
  await writeJson(manifestPath, {
    schema_version: "oracle.chatgpt-conversation-export.manifest.v1",
    created_at: new Date().toISOString(),
    target_url: payload.target_url,
    final_url: payload.final_url,
    conversation_id: payload.conversation_id,
    expected_conversation_id: payload.expected_conversation_id,
    scope_ok: payload.scope_ok === true,
    extraction_method: payload.extraction_method,
    turn_count: stats.turn_count,
    user_turns: stats.user_turns,
    assistant_turns: stats.assistant_turns,
    tool_turns: stats.tool_turns,
    system_turns: stats.system_turns,
    stats,
    backend_probe: payload.backend_probe,
    files,
    non_claims: [
      "No cookies, localStorage, profile stores, credential values, or unrelated history left the authenticated page context.",
      "The page requested and captured only the exact approved backend conversation URL.",
    ],
  });
  const redactionReport = await buildRedactionReport(outDir, [
    "backend-conversation.json",
    "backend-capture-info.json",
    "conversation.json",
    "payload.json",
    "conversation.md",
    "manifest.json",
  ]);
  await writeJson(redactionReportPath, redactionReport);
  const sha256SumsPath = await writeSha256Sums(outDir, files);
  return {
    rawBackendPath,
    payloadPath,
    markdownPath,
    manifestPath,
    captureInfoPath,
    sha256SumsPath,
  };
}

export async function writeChatGptExportBundleForTest(
  options: Parameters<typeof writeBundle>[0],
): Promise<void> {
  await writeBundle(options);
}

async function finalizeCapturedExport({
  backend,
  rawText,
  targetUrl,
  targetApiUrl,
  outDir,
  targetId,
  tabUrl,
  captureInfo,
  turnAffinity,
}: {
  backend: BackendConversation;
  rawText: string;
  targetUrl: string;
  targetApiUrl: string;
  outDir: string;
  targetId: string;
  tabUrl: string;
  captureInfo: JsonRecord;
  turnAffinity?: ChatGptExportTurnAffinity;
}): Promise<Omit<ChatGptConversationExportResult, "archiveRecovery" | "postExportArchive">> {
  const conversationId = conversationIdFromChatGptUrl(targetUrl);
  if (backend.conversation_id !== conversationId) {
    throw new Error(`Captured wrong conversation id: ${backend.conversation_id ?? "(missing)"}`);
  }
  const rawBackendSha256 = hashText(rawText);
  const rawBackendSizeBytes = Buffer.byteLength(rawText, "utf8");
  const payload = backendToPayload(
    backend,
    targetUrl,
    rawBackendSha256,
    rawBackendSizeBytes,
    turnAffinity,
  );
  const bundle = await writeBundle({
    outDir,
    rawText,
    payload,
    captureInfo: {
      ...captureInfo,
      raw_backend_sha256: rawBackendSha256,
      raw_backend_size_bytes: rawBackendSizeBytes,
    },
  });
  const stats = asRecord(payload.stats);
  return {
    ok: true,
    outputDir: outDir,
    targetUrl,
    targetApiUrl,
    conversationId,
    title: backend.title,
    targetId,
    tabUrl,
    rawBackendPath: bundle.rawBackendPath,
    rawBackendSha256,
    rawBackendSizeBytes,
    payloadPath: bundle.payloadPath,
    markdownPath: bundle.markdownPath,
    manifestPath: bundle.manifestPath,
    captureInfoPath: bundle.captureInfoPath,
    sha256SumsPath: bundle.sha256SumsPath,
    mappingCount: Object.keys(backend.mapping ?? {}).length,
    currentPathNodeCount: Number(stats.current_path_node_count ?? 0),
    turnCount: Number(stats.turn_count ?? 0),
    stats,
  };
}

export async function captureApprovedChatGptConversationBackend(
  options: ChatGptConversationExportOptions,
): Promise<ChatGptConversationExportResult> {
  const conversationId = conversationIdFromChatGptUrl(options.targetUrl);
  const targetApiUrl = buildBackendConversationUrl(conversationId);
  const host = options.host ?? DEFAULT_REMOTE_CHROME_HOST;
  const port = options.port ?? DEFAULT_REMOTE_CHROME_PORT;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const expectedBrowserId = options.browserId?.trim();
  let browserWSEndpoint = options.browserWSEndpoint?.trim();
  const expectedAccountDigest = options.accountDigest?.trim();
  const expectedWorkspaceDigest = options.workspaceDigest?.trim();
  if (expectedBrowserId || browserWSEndpoint || expectedAccountDigest) {
    if (!expectedBrowserId || !browserWSEndpoint || !expectedAccountDigest) {
      throw new Error(
        "ChatGPT export browser affinity requires browser id, WebSocket, and account identity.",
      );
    }
    if (browserIdFromWebSocketEndpoint(browserWSEndpoint) !== expectedBrowserId) {
      throw new Error("ChatGPT export browser id does not match its WebSocket.");
    }
    if (!/^[a-f0-9]{64}$/.test(expectedAccountDigest)) {
      throw new Error("ChatGPT export account identity is invalid.");
    }
    if (expectedWorkspaceDigest && !/^[a-f0-9]{64}$/.test(expectedWorkspaceDigest)) {
      throw new Error("ChatGPT export workspace identity is invalid.");
    }
    const liveIdentity = await resolveRemoteChromeBrowserIdentity({ host, port });
    if (liveIdentity.browserId !== expectedBrowserId) {
      throw new Error("Remote Chrome browser identity changed before ChatGPT export.");
    }
    browserWSEndpoint = liveIdentity.browserWSEndpoint;
  }
  const chunkSize = options.chunkSize ?? 250_000;
  const tabRef = options.tabRef ?? options.targetUrl;
  const outDir = path.resolve(options.outDir);
  let resolved: {
    client: Awaited<ReturnType<typeof connectToExistingChatGptTab>>["client"];
    targetId: string;
    tabUrl: string;
    tabTitle: string;
    recovery: ChatGptArchiveRecoveryResult;
    close: () => Promise<void>;
  };
  try {
    const connected = await connectToExistingChatGptTab({
      host,
      port,
      browserWSEndpoint,
      browserId: expectedBrowserId,
      accountDigest: expectedAccountDigest,
      ref: tabRef,
    });
    if (
      !(await isExpectedConversationScope(
        connected.client.Runtime,
        options.targetUrl,
        "conversation scope",
      ))
    ) {
      await connected.client.close().catch(() => undefined);
      throw new Error("Resolved ChatGPT tab is not the approved target conversation.");
    }
    resolved = {
      client: connected.client,
      targetId: connected.targetId,
      tabUrl: options.targetUrl,
      tabTitle: connected.tab.title,
      recovery: { attempted: false, recovered: false, status: "not-needed" },
      close: async () => {
        await connected.client.close().catch(() => undefined);
      },
    };
  } catch (error) {
    if (options.recoverArchived === false) throw error;
    if (!expectedAccountDigest || !expectedWorkspaceDigest) {
      throw new Error(
        "ChatGPT tab resolution failed; archived recovery requires exact account and workspace identity.",
      );
    }
    const recovered = await recoverArchivedConversation({
      targetUrl: options.targetUrl,
      host,
      port,
      browserWSEndpoint,
      timeoutMs,
      accountDigest: expectedAccountDigest,
      workspaceDigest: expectedWorkspaceDigest,
    });
    resolved = {
      client: recovered.client,
      targetId: recovered.targetId,
      tabUrl: recovered.tabUrl,
      tabTitle: "",
      recovery: recovered.recovery,
      close: recovered.close,
    };
  }
  const { client, targetId, tabUrl, tabTitle, recovery, close } = resolved;
  const { Page, Runtime } = client;
  let archiveRestored = false;
  let captureHookInstalled = false;
  let captureScriptIdentifier: string | undefined;
  let captureRegistrationAttempted = false;
  let operationFailure: unknown;
  const captureOwner = randomUUID();
  try {
    if (expectedWorkspaceDigest) {
      const observed = await readChatGptIdentityDigests(Runtime);
      if (
        observed.accountDigest !== expectedAccountDigest ||
        observed.workspaceDigest !== expectedWorkspaceDigest
      ) {
        throw new Error(
          "Remote Chrome account or workspace identity changed before ChatGPT export.",
        );
      }
    } else if (expectedAccountDigest) {
      const observedAccountDigest = await readChatGptAccountDigest(Runtime);
      if (observedAccountDigest !== expectedAccountDigest) {
        throw new Error("Remote Chrome account identity changed before ChatGPT export.");
      }
    }
    captureHookInstalled = true;
    captureRegistrationAttempted = true;
    captureScriptIdentifier = (
      await Page.addScriptToEvaluateOnNewDocument({
        source: buildScopedBackendCaptureHook(targetApiUrl, {
          targetUrl: options.targetUrl,
          accountDigest: expectedAccountDigest,
          workspaceDigest: expectedWorkspaceDigest,
          owner: captureOwner,
        }),
      })
    ).identifier;
    await Page.enable();
    const captureDeadline = Date.now() + timeoutMs;
    await runBeforeCaptureDeadline(captureDeadline, () => Page.reload({ ignoreCache: true }));
    const capture = await pollCapture(
      Runtime,
      targetApiUrl,
      remainingCaptureBudget(captureDeadline),
      { expectedOwner: captureOwner },
    );
    await assertChatGptExportMutationAffinity(
      Runtime,
      expectedAccountDigest,
      options.targetUrl,
      "export capture",
      expectedWorkspaceDigest,
      captureDeadline,
    );
    const hit = capture.hit;
    if (!hit?.chars) {
      throw new Error("Capture did not return the approved conversation response.");
    }
    const rawText = await retrieveCapturedText(
      Runtime,
      targetApiUrl,
      hit.chars,
      chunkSize,
      captureDeadline,
      captureOwner,
      (deadline) =>
        assertChatGptExportMutationAffinity(
          Runtime,
          expectedAccountDigest,
          options.targetUrl,
          "export retrieval",
          expectedWorkspaceDigest,
          deadline,
        ),
    );
    await assertChatGptExportMutationAffinity(
      Runtime,
      expectedAccountDigest,
      options.targetUrl,
      "export finalization",
      expectedWorkspaceDigest,
      captureDeadline,
    );
    const backend = JSON.parse(rawText) as BackendConversation;
    if (backend.conversation_id !== conversationId) {
      throw new Error("Capture did not return the approved conversation id.");
    }
    await cleanupScopedBackendCapture(
      Runtime,
      Page,
      targetApiUrl,
      captureScriptIdentifier,
      captureOwner,
      captureRegistrationAttempted,
    );
    captureHookInstalled = false;
    captureScriptIdentifier = undefined;
    captureRegistrationAttempted = false;
    const result = await finalizeCapturedExport({
      backend,
      rawText,
      targetUrl: options.targetUrl,
      targetApiUrl,
      outDir,
      targetId,
      tabUrl,
      turnAffinity: options.turnAffinity,
      captureInfo: {
        captured_at: new Date().toISOString(),
        target_url: options.targetUrl,
        target_api_url: targetApiUrl,
        tab: {
          host,
          port,
          target_id: targetId,
          url_before_reload: tabUrl,
          title_before_reload: tabTitle,
        },
        hit: Object.fromEntries(Object.entries(hit).filter(([key]) => key !== "bodyPreview")),
        non_claims: [
          "No cookies, localStorage, profile stores, credential values, or unrelated history left the authenticated page context.",
          "The page requested and captured only the exact approved backend conversation URL.",
          "Archive recovery, when needed, reuses ChatGPT's own authenticated archived-list request only to PATCH the exact approved conversation id and does not record credential values or unrelated conversation payloads.",
        ],
      },
    });
    const shouldArchive = options.archiveAfterExport === true || recovery.recovered;
    let postExportArchive: BrowserArchiveResult | undefined;
    if (shouldArchive) {
      await assertChatGptExportMutationAffinity(
        Runtime,
        expectedAccountDigest,
        options.targetUrl,
        "post-export archive",
        expectedWorkspaceDigest,
      );
      postExportArchive = await archiveChatGptConversation(Runtime, () => {}, {
        mode: "always",
        conversationUrl: options.targetUrl,
        expectedAccountDigest,
        expectedWorkspaceDigest,
      });
      if (!postExportArchive.archived) {
        throw new Error(`Post-export archive failed: ${JSON.stringify(postExportArchive)}`);
      }
      archiveRestored = recovery.recovered;
    }
    return { ...result, archiveRecovery: recovery, postExportArchive };
  } catch (error) {
    operationFailure = error;
    if (recovery.recovered && !archiveRestored) {
      const restore = await (async () => {
        await assertChatGptExportMutationAffinity(
          client.Runtime,
          expectedAccountDigest,
          options.targetUrl,
          "archive restore",
          expectedWorkspaceDigest,
        );
        return archiveChatGptConversation(client.Runtime, () => {}, {
          mode: "always",
          conversationUrl: options.targetUrl,
          expectedAccountDigest,
          expectedWorkspaceDigest,
        });
      })().catch(() => null);
      if (!restore?.archived) {
        const restoreError = new Error(
          `${error instanceof Error ? error.message : String(error)}; archive restore also failed`,
        );
        operationFailure = restoreError;
        throw restoreError;
      }
    }
    throw error;
  } finally {
    try {
      if (captureHookInstalled || captureRegistrationAttempted) {
        await cleanupScopedBackendCapture(
          Runtime,
          Page,
          targetApiUrl,
          captureScriptIdentifier,
          captureOwner,
          captureRegistrationAttempted,
        );
      }
    } finally {
      captureRegistrationAttempted = false;
      try {
        await close();
      } catch (error) {
        if (recovery.recovered) {
          const cleanup = sanitizeErrorForPersistence(
            error instanceof Error ? error.message : String(error),
            error instanceof BrowserAutomationError ? error.details : undefined,
          );
          const operation =
            operationFailure === undefined
              ? undefined
              : sanitizeErrorForPersistence(
                  operationFailure instanceof Error
                    ? operationFailure.message
                    : String(operationFailure),
                  operationFailure instanceof BrowserAutomationError
                    ? operationFailure.details
                    : undefined,
                );
          // oxlint-disable-next-line no-unsafe-finally -- a recovered target close failure must prevent a false export success.
          throw new BrowserAutomationError(
            operation
              ? `${operation.message}; archived recovery target cleanup was inconclusive.`
              : "Archived recovery target cleanup was inconclusive; export result was not returned.",
            {
              stage: "chatgpt-export",
              code: "archive-recovery-target-close-failed",
              recoveryHandle: {
                transport: "cdp",
                ...(browserWSEndpoint ? { browserWSEndpoint } : {}),
                targetId,
                conversationUrl: options.targetUrl,
              },
              cleanupFailure: cleanup,
              ...(operation ? { operationFailure: operation } : {}),
            },
            operationFailure ?? error,
          );
        }
      }
    }
  }
}

export async function finalizeCompletedOpenBrowserUseExport(
  connection: Pick<OpenBrowserUseConnection, "finalize">,
  onFailure?: (error: unknown) => Promise<void> | void,
): Promise<BrowserRunWarning[] | undefined> {
  try {
    await connection.finalize(false);
    return undefined;
  } catch (error) {
    await onFailure?.(error);
    const detailMessage = error instanceof Error ? error.message : String(error);
    const details = error instanceof BrowserAutomationError ? error.details : undefined;
    const sanitized = sanitizeErrorForPersistence(detailMessage, details);
    return [
      {
        code: "obu-tab-finalize-failed",
        severity: "warning",
        message: `Export completed, but Oracle could not finalize its task-owned main-Chrome tab: ${sanitized.message}`,
        ...(sanitized.details ? { details: sanitized.details } : {}),
      },
    ];
  }
}

export async function captureApprovedChatGptConversationBackendViaObu(
  options: ChatGptConversationExportObuOptions,
): Promise<ChatGptConversationExportResult> {
  const conversationId = conversationIdFromChatGptUrl(options.targetUrl);
  const targetApiUrl = buildBackendConversationUrl(conversationId);
  const timeoutMs = options.timeoutMs ?? 45_000;
  const chunkSize = options.chunkSize ?? 250_000;
  const outDir = path.resolve(options.outDir);
  const logger = () => {};
  const expectation = {
    email: options.email,
    workspaceName: options.workspaceName,
    accountDigest: options.accountDigest,
    workspaceDigest: options.workspaceDigest,
  };
  const lock = await acquireOpenBrowserUseRunLock({ timeoutMs: 300_000, logger });
  let connection: Awaited<ReturnType<typeof connectOpenBrowserUseTab>> | null = null;
  let connectionReady: ReturnType<typeof connectOpenBrowserUseTab> | null = null;
  let completed = false;
  let routeRetained = false;
  let captureHookInstalled = false;
  let captureScriptIdentifier: string | undefined;
  let captureRegistrationAttempted = false;
  const captureOwner = randomUUID();
  let terminationRequested = false;
  let exportFailure: BrowserAutomationError | undefined;
  let captureCleanupPromise: Promise<void> | null = null;
  let captureRegistrationPromise: Promise<void> | null = null;
  let exportCleanupUncertain = false;
  const markExportCleanupUncertain = async (reason: string, error?: unknown): Promise<void> => {
    exportCleanupUncertain = true;
    const details = error instanceof BrowserAutomationError ? error.details : undefined;
    const candidate = details?.recoveryHandle;
    const recoveryHandle =
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : connection
          ? {
              transport: "obu",
              sessionId: connection.sessionId,
              tabId: connection.tabId,
              conversationUrl: options.targetUrl,
            }
          : undefined;
    try {
      await lock.markUncertain?.({
        reason,
        ...(recoveryHandle ? { recoveryHandle } : {}),
      });
    } catch {
      // Keep the in-memory uncertainty flag set; never release after an unverified transition.
    }
  };
  const cleanupCapture = async (): Promise<void> => {
    if (captureRegistrationPromise) {
      try {
        await captureRegistrationPromise;
      } catch {
        // The cleanup path records the unresolved registration as residue below.
      }
    }
    if (!connection || (!captureHookInstalled && !captureRegistrationAttempted)) return;
    const cleanupPromise =
      captureCleanupPromise ??
      (captureCleanupPromise = (async () => {
        await cleanupScopedBackendCapture(
          connection!.client.Runtime,
          connection!.client.Page,
          targetApiUrl,
          captureScriptIdentifier,
          captureOwner,
          captureRegistrationAttempted,
        );
        captureHookInstalled = false;
        captureScriptIdentifier = undefined;
        captureRegistrationAttempted = false;
      })());
    try {
      await cleanupPromise;
    } finally {
      if (captureCleanupPromise === cleanupPromise) captureCleanupPromise = null;
    }
  };
  const removeTerminationHooks = registerOpenBrowserUseTerminationHooks({
    connection: () => connection ?? connectionReady,
    preserveTab: () => {
      terminationRequested = true;
      connection?.requestKeepTab?.();
    },
    beforeFinalize: async () => {
      terminationRequested = true;
      if (!connection && connectionReady) {
        try {
          connection = await connectionReady;
        } catch {
          return;
        }
      }
      await cleanupCapture();
    },
    releaseLock: () => lock.release(),
    markLockUncertain: (details) => lock.markUncertain?.(details),
    logger,
  });
  try {
    connectionReady = connectOpenBrowserUseTab({
      oracleSessionId: options.oracleSessionId
        ? `export-${options.oracleSessionId}`
        : `export-${conversationId}`,
      obuSessionId: options.obuSessionId,
      obuTabId: options.obuTabId,
      conversationUrl: options.targetUrl,
      timeoutMs,
      logger,
    });
    connection = await connectionReady;
    const { Page, Runtime } = connection.client;
    if (terminationRequested)
      throw new Error("Oracle export interrupted before route preparation.");
    await prepareOpenBrowserUseConversationRoute({
      connection,
      expectation,
      targetUrl: options.targetUrl,
      logger,
    });
    if (terminationRequested)
      throw new Error("Oracle export interrupted before capture hook installation.");
    routeRetained = true;
    captureHookInstalled = true;
    captureRegistrationAttempted = true;
    const registration = (async () => {
      const addedCaptureScript = await Page.addScriptToEvaluateOnNewDocument({
        source: buildScopedBackendCaptureHook(targetApiUrl, {
          targetUrl: options.targetUrl,
          accountDigest: options.accountDigest,
          workspaceDigest: options.workspaceDigest,
          owner: captureOwner,
        }),
      });
      captureScriptIdentifier = addedCaptureScript.identifier;
    })();
    captureRegistrationPromise = registration;
    try {
      await registration;
    } finally {
      if (captureRegistrationPromise === registration) captureRegistrationPromise = null;
    }
    if (terminationRequested) {
      await cleanupCapture();
      throw new Error("Oracle export interrupted during capture hook installation.");
    }
    if (terminationRequested) throw new Error("Oracle export interrupted before capture reload.");
    await Page.enable();
    if (terminationRequested) {
      await cleanupCapture();
      throw new Error("Oracle export interrupted before capture reload.");
    }
    const captureStartedAt = Date.now();
    const captureDeadline = captureStartedAt + timeoutMs;
    const passiveCaptureDeadline = Math.min(
      captureDeadline,
      captureStartedAt + PASSIVE_CAPTURE_WINDOW_MS,
    );
    await runBeforeCaptureDeadline(captureDeadline, () => Page.reload({ ignoreCache: true }));
    await runBeforeCaptureDeadline(captureDeadline, (remainingMs) =>
      waitForDocument(Runtime, remainingMs),
    );
    const capture = await pollCapture(
      Runtime,
      targetApiUrl,
      remainingCaptureBudget(captureDeadline),
      {
        expectedOwner: captureOwner,
        passiveDeadline: passiveCaptureDeadline,
        requestFallback: (remainingMs) =>
          requestApprovedBackendCapture({
            Runtime,
            targetUrl: options.targetUrl,
            targetApiUrl,
            email: options.email,
            accountDigest: options.accountDigest,
            workspaceDigest: options.workspaceDigest,
            timeoutMs: remainingMs,
            captureOwner,
          }),
      },
    );
    const hit = capture.hit;
    if (!hit?.chars) {
      throw new Error("Capture did not return the approved conversation response.");
    }
    await runBeforeCaptureDeadline(captureDeadline, () =>
      assertChatGptIdentity(Runtime, expectation),
    );
    if (
      !(await runBeforeCaptureDeadline(captureDeadline, () =>
        isExpectedConversationScope(Runtime, options.targetUrl, "current URL check"),
      ))
    ) {
      throw new Error("Resolved OBU tab is not the approved target conversation.");
    }
    const currentUrl = options.targetUrl;
    const rawText = await retrieveCapturedText(
      Runtime,
      targetApiUrl,
      hit.chars,
      chunkSize,
      captureDeadline,
      captureOwner,
      (deadline) =>
        assertChatGptExportMutationAffinity(
          Runtime,
          options.accountDigest,
          options.targetUrl,
          "export retrieval",
          options.workspaceDigest,
          deadline,
        ),
    );
    await assertChatGptExportMutationAffinity(
      Runtime,
      options.accountDigest,
      options.targetUrl,
      "export finalization",
      options.workspaceDigest,
      captureDeadline,
    );
    const backend = JSON.parse(rawText) as BackendConversation;
    if (backend.conversation_id !== conversationId) {
      throw new Error("Capture did not return the approved conversation id.");
    }
    try {
      await cleanupCapture();
    } catch (error) {
      routeRetained = false;
      throw error;
    }
    if (terminationRequested)
      throw new Error("Oracle export interrupted before local finalization.");
    const result = await finalizeCapturedExport({
      backend,
      rawText,
      targetUrl: options.targetUrl,
      targetApiUrl,
      outDir,
      targetId: `obu:${connection.sessionId}:${connection.tabId}`,
      tabUrl: currentUrl,
      turnAffinity: options.turnAffinity,
      captureInfo: {
        captured_at: new Date().toISOString(),
        target_url: options.targetUrl,
        target_api_url: targetApiUrl,
        tab: {
          transport: "obu",
          session_id: connection.sessionId,
          tab_id: connection.tabId,
          originating_session_id: options.obuSessionId,
          originating_tab_id: options.obuTabId,
          url_before_reload: currentUrl,
        },
        hit: Object.fromEntries(Object.entries(hit).filter(([key]) => key !== "bodyPreview")),
        non_claims: [
          "No cookies, localStorage, profile stores, credential values, or unrelated history left the authenticated page context.",
          "The page requested and captured only the exact approved backend conversation URL.",
        ],
      },
    });
    if (terminationRequested)
      throw new Error("Oracle export interrupted after local finalization.");
    let postExportArchive: BrowserArchiveResult | undefined;
    if (options.archiveAfterExport === true) {
      if (terminationRequested)
        throw new Error("Oracle export interrupted before post-export archive.");
      await assertChatGptIdentity(Runtime, expectation);
      await assertChatGptExportMutationAffinity(
        Runtime,
        options.accountDigest,
        options.targetUrl,
        "post-export archive",
        options.workspaceDigest,
      );
      if (terminationRequested)
        throw new Error("Oracle export interrupted before post-export archive.");
      postExportArchive = await archiveChatGptConversation(Runtime, logger, {
        mode: "always",
        conversationUrl: options.targetUrl,
        expectedAccountDigest: options.accountDigest,
        expectedWorkspaceDigest: options.workspaceDigest,
      });
      if (!postExportArchive.archived) {
        throw new Error(`Post-export archive failed: ${JSON.stringify(postExportArchive)}`);
      }
    }
    if (terminationRequested) throw new Error("Oracle export interrupted before tab finalization.");
    const warnings = await finalizeCompletedOpenBrowserUseExport(connection, (error) =>
      markExportCleanupUncertain("Main-Chrome export tab finalization was inconclusive.", error),
    );
    completed = true;
    return {
      ...result,
      archiveRecovery: { attempted: false, recovered: false, status: "not-needed" },
      postExportArchive,
      warnings,
    };
  } catch (error) {
    if (connection && routeRetained) {
      try {
        await assertChatGptIdentity(connection.client.Runtime, expectation);
        routeRetained = await isExpectedConversationScope(
          connection.client.Runtime,
          options.targetUrl,
          "failed export route check",
        );
      } catch {
        routeRetained = false;
      }
    }
    if (!connection) throw error;
    const details = error instanceof BrowserAutomationError ? error.details : undefined;
    exportFailure = new BrowserAutomationError(
      error instanceof Error ? error.message : String(error),
      {
        ...details,
        stage: details?.stage ?? "chatgpt-export",
        recoveryHandle: {
          transport: "obu",
          sessionId: connection.sessionId,
          tabId: connection.tabId,
          conversationUrl: options.targetUrl,
          email: options.email,
          workspaceName: options.workspaceName,
        },
      },
      error,
    );
    throw exportFailure;
  } finally {
    let cleanupError: unknown;
    try {
      await cleanupCapture();
    } catch (error) {
      routeRetained = false;
      cleanupError = error;
      await markExportCleanupUncertain(
        "Main-Chrome export capture cleanup was inconclusive.",
        error,
      );
    }
    await removeTerminationHooks.waitForDrain();
    try {
      if (!removeTerminationHooks.isTerminating()) {
        try {
          await connection?.finalize(!completed && (routeRetained || cleanupError !== undefined));
        } catch (error) {
          await markExportCleanupUncertain(
            "Main-Chrome export task-tab finalization was inconclusive.",
            error,
          );
          if (exportFailure?.details) {
            (exportFailure.details as Record<string, unknown>).cleanupFailure =
              error instanceof BrowserAutomationError
                ? { message: error.message, details: error.details }
                : { message: error instanceof Error ? error.message : String(error) };
          }
        }
      }
    } finally {
      await removeTerminationHooks.waitForDrain();
      if (!exportCleanupUncertain && !removeTerminationHooks.isLockUncertain()) {
        await lock.release().catch(() => undefined);
      }
      removeTerminationHooks();
    }
    if (cleanupError !== undefined) {
      if (exportFailure?.details) {
        (exportFailure.details as Record<string, unknown>).cleanupFailure =
          cleanupError instanceof BrowserAutomationError
            ? { message: cleanupError.message, details: cleanupError.details }
            : {
                message:
                  cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              };
      } else {
        // oxlint-disable-next-line no-unsafe-finally -- cleanup residue must remain visible after release.
        throw cleanupError;
      }
    }
  }
}
