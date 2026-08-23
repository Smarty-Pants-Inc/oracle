import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserArchiveResult, ChromeClient } from "./types.js";
import type { BrowserRunWarning } from "../sessionStore.js";
import { archiveChatGptConversation } from "./actions/archiveConversation.js";
import {
  connectToExistingChatGptTab,
  DEFAULT_REMOTE_CHROME_HOST,
  DEFAULT_REMOTE_CHROME_PORT,
  openChatGptTarget,
} from "./liveTabs.js";
import { delay } from "./utils.js";
import {
  browserIdFromWebSocketEndpoint,
  resolveRemoteChromeBrowserIdentity,
} from "./profileState.js";
import {
  isChatGptScopeRetained,
  readChatGptAccountDigest,
  readChatGptIdentityDigests,
} from "./pageActions.js";
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
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      "target-url must be https://chatgpt.com/c/<conversation-id> or https://chatgpt.com/g/<project>/c/<conversation-id>",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "chatgpt.com" ||
    Boolean(parsed.port) ||
    Boolean(parsed.username || parsed.password) ||
    parsed.pathname.includes("%")
  ) {
    throw new Error(
      "target-url must be https://chatgpt.com/c/<conversation-id> or https://chatgpt.com/g/<project>/c/<conversation-id>",
    );
  }
  const match = /^(?:\/c|\/g\/[^/?#]+\/c)\/([^/?#]+)\/?$/.exec(parsed.pathname);
  if (!match?.[1]) {
    throw new Error(
      "target-url must be a specific ChatGPT conversation URL: https://chatgpt.com/c/<conversation-id> or https://chatgpt.com/g/<project>/c/<conversation-id>",
    );
  }
  return match[1];
}
function chatGptConversationScope(rawUrl: string): {
  conversationId: string;
  projectKey: string | null;
} {
  const conversationId = conversationIdFromChatGptUrl(rawUrl);
  const project = /^\/g\/([^/?#]+)\/c\//.exec(new URL(rawUrl).pathname)?.[1];
  const projectKey = project
    ? (project.match(/^(g-p-[0-9a-f]{32})(?=-|$)/iu)?.[1] ?? project).toLowerCase()
    : null;
  return { conversationId, projectKey };
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
    return isChatGptScopeRetained(actualUrl, expectedUrl);
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
): Promise<void> {
  if (expectedWorkspaceDigest) {
    const observed = await readChatGptIdentityDigests(Runtime);
    if (observed.accountDigest !== expectedAccountDigest) {
      throw new Error(`Remote Chrome account identity changed before ${action}.`);
    }
    if (observed.workspaceDigest !== expectedWorkspaceDigest) {
      throw new Error(`Remote Chrome workspace identity changed before ${action}.`);
    }
  } else if (expectedAccountDigest) {
    const observedAccountDigest = await readChatGptAccountDigest(Runtime);
    if (observedAccountDigest !== expectedAccountDigest) {
      throw new Error(`Remote Chrome account identity changed before ${action}.`);
    }
  }
  if (!(await isExpectedConversationScope(Runtime, expectedUrl, "conversation scope"))) {
    throw new Error(`ChatGPT conversation changed before ${action}.`);
  }
}

export async function assertChatGptExportMutationAffinityForTest(
  Runtime: ChromeClient["Runtime"],
  expectedAccountDigest: string | undefined,
  expectedUrl: string,
  action = "archive mutation",
  expectedWorkspaceDigest?: string,
): Promise<void> {
  await assertChatGptExportMutationAffinity(
    Runtime,
    expectedAccountDigest,
    expectedUrl,
    action,
    expectedWorkspaceDigest,
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
  } = {},
): string {
  const routeCheck = options.targetUrl
    ? buildExpectedConversationScopeCheckExpression(options.targetUrl)
    : "true";
  return `
(() => {
  const TARGET = ${jsString(targetApiUrl)};
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
  const state = window.__oracleChatGptBackendCapture = {
    target: TARGET,
    hits: [],
    requests: { started: 0, pending: 0, completed: 0 }
  };
  const originalFetch = window.fetch;
  const routeMatches = () => Boolean(${routeCheck});
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
    if (url !== TARGET || String(method || "GET").toUpperCase() !== "GET") return null;
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
    state.requests.pending = Math.max(0, state.requests.pending - 1);
    state.requests.completed += 1;
  };
  const recordError = (request, error) => {
    state.hits.push({
      kind: request.kind,
      url: request.url,
      error: String(error),
      capturedAt: new Date().toISOString()
    });
  };
  const record = async (request, response) => {
    try {
      const text = await response.clone().text();
      const affinityMatched =
        isApprovedText(text) &&
        await request.affinity &&
        await captureAffinityMatches();
      const capturedText = affinityMatched ? text : "";
      if (affinityMatched) {
        try {
          sessionStorage.setItem("__oracleChatGptBackendCapture:" + TARGET, capturedText);
        } catch {}
      }
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
  window.fetch = function(input, init) {
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
  const OriginalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OriginalXHR();
    let requestUrl = "";
    let requestMethod = "GET";
    let request = null;
    const requestHeaders = new Headers();
    const open = xhr.open;
    xhr.open = function(method, url) {
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
        const capturedText = affinityMatched ? text : "";
        if (affinityMatched) {
          try {
            sessionStorage.setItem("__oracleChatGptBackendCapture:" + TARGET, capturedText);
          } catch {}
        }
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
    const passiveRequestObserved = () => {
      const capture = globalThis.__oracleChatGptBackendCapture;
      return capture?.target === targetApiUrl && Number(capture?.requests?.pending || 0) > 0;
    };
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
}): Promise<void> {
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
  if (result?.status === "captured" || result?.code === "passive-request-observed") return;
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
  } = {},
): string {
  return buildArchivedConversationRecoveryHook({
    targetUrl: options.targetUrl ?? `https://chatgpt.com/c/${conversationId}`,
    accountDigest: options.accountDigest ?? "a".repeat(64),
    workspaceDigest: options.workspaceDigest ?? "b".repeat(64),
  });
}

function buildArchivedConversationRecoveryHook(options: {
  targetUrl: string;
  accountDigest: string;
  workspaceDigest: string;
}): string {
  const scope = chatGptConversationScope(options.targetUrl);
  const targetApiUrl = buildBackendConversationUrl(scope.conversationId);
  return `
(() => {
  const TARGET = ${jsString(targetApiUrl)};
  const EXPECTED_PROJECT_KEY = ${JSON.stringify(scope.projectKey)};
  const EXPECTED_ACCOUNT_DIGEST = ${jsString(options.accountDigest)};
  const EXPECTED_WORKSPACE_DIGEST = ${jsString(options.workspaceDigest)};
  const KEY = "__oracleArchivedConversationRecovery";
  if (window[KEY]?.target === TARGET && window[KEY]?.status === "pending") return;
  const state = window[KEY] = {
    target: TARGET,
    status: "pending",
    attempted: false,
    recovered: false
  };
  const originalFetch = window.fetch.bind(window);
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
        current.pathname.includes("%")
      ) return false;
      if (EXPECTED_PROJECT_KEY === null) return current.pathname === "/";
      const project = new RegExp("^/g/([^/?#]+)/project/?$").exec(current.pathname);
      return Boolean(project?.[1] && stableProjectKey(project[1]) === EXPECTED_PROJECT_KEY);
    } catch {
      return false;
    }
  };
  const identityMatches = async () => {
    if (!routeMatches()) return false;
    try {
      const response = await originalFetch("/api/auth/session", {
        cache: "no-store",
        credentials: "include"
      });
      if (!response.ok) return false;
      const body = await response.json();
      return (
        await digest(body?.user?.id) === EXPECTED_ACCOUNT_DIGEST &&
        await digest(body?.account?.id) === EXPECTED_WORKSPACE_DIGEST &&
        routeMatches()
      );
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
      if (await digest(session?.user?.id) !== EXPECTED_ACCOUNT_DIGEST) return null;
      if (await digest(accountId) !== EXPECTED_WORKSPACE_DIGEST) return null;
      return routeMatches() ? { accessToken, accountId } : null;
    } catch {
      return null;
    }
  };
  window.fetch = async function(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url, location.href);
    const isArchivedListRequest =
      state.status === "pending" &&
      request.method.toUpperCase() === "GET" &&
      url.origin === "https://chatgpt.com" &&
      url.pathname === "/backend-api/conversations" &&
      url.searchParams.get("is_archived") === "true";
    const requestIdentity = isArchivedListRequest ? identityMatches() : null;
    const requestCredentials = isArchivedListRequest ? currentPageCredentials() : null;
    const response = await originalFetch(input, init);
    try {
      if (state.status === "pending" && isArchivedListRequest) {
        state.attempted = true;
        state.listStatus = response.status;
        const headers = new Headers(request.headers);
        const initialCredentials = requestCredentials ? await requestCredentials : null;
        const currentCredentials = await currentPageCredentials();
        const requestWorkspaceDigest = await digest(headers.get("ChatGPT-Account-Id"));
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
        headers.set("Authorization", "Bearer " + currentCredentials.accessToken);
        headers.set("ChatGPT-Account-Id", currentCredentials.accountId);
        headers.set("content-type", "application/json");
        headers.delete("content-length");
        headers.delete("x-openai-target-path");
        headers.delete("x-openai-target-route");
        const patch = await originalFetch(TARGET, {
          method: "PATCH",
          headers,
          credentials: "include",
          body: JSON.stringify({ is_archived: false })
        });
        state.patchStatus = patch.status;
        state.recovered = patch.ok;
        state.status = patch.ok ? "recovered" : "failed";
        if (!patch.ok) state.code = "patch-failed";
      }
    } catch {
      state.status = "failed";
      state.code = "recovery-failed";
    }
    return response;
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
  client: Awaited<ReturnType<typeof connectToExistingChatGptTab>>["client"];
  targetId: string;
  tabUrl: string;
  recovery: ChatGptArchiveRecoveryResult;
}> {
  const settingsUrl = archivedSettingsUrlFromConversationUrl(targetUrl);
  const targetId = await openChatGptTarget({
    host,
    port,
    browserWSEndpoint,
    url: "https://chatgpt.com/",
  });
  const { client } = await connectToExistingChatGptTab({
    host,
    port,
    browserWSEndpoint,
    ref: targetId,
  });
  try {
    const { Page, Runtime } = client;
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
    });
    await Runtime.evaluate({
      expression: recoveryHook,
      awaitPromise: false,
      returnByValue: true,
    });
    await Page.addScriptToEvaluateOnNewDocument({ source: recoveryHook });
    await Page.navigate({ url: settingsUrl });
    const deadline = Date.now() + timeoutMs;
    let state: JsonRecord = {};
    while (Date.now() < deadline) {
      state = await evaluateByValue<JsonRecord>(
        Runtime,
        "window.__oracleArchivedConversationRecovery || {}",
        "archive recovery",
      );
      if (state.status === "recovered") break;
      if (state.status === "failed") {
        throw new Error("Archived conversation recovery failed.");
      }
      await delay(200);
    }
    if (state.status !== "recovered") {
      throw new Error("Timed out recovering the archived ChatGPT conversation.");
    }
    await Page.navigate({ url: targetUrl });
    const tabUrl = await waitForConversationUrl(Runtime, targetUrl, timeoutMs);
    await waitForDocument(Runtime, timeoutMs);
    return {
      client,
      targetId,
      tabUrl,
      recovery: {
        attempted: true,
        recovered: true,
        status: "recovered",
        settingsUrl,
        patchStatus: Number(state.patchStatus),
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function evaluateByValue<T>(
  Runtime: ChromeClient["Runtime"],
  expression: string,
  timeoutLabel = "Runtime.evaluate",
): Promise<T> {
  const result = await Runtime.evaluate({
    expression,
    awaitPromise: false,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`${timeoutLabel} failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result?.value as T;
}

interface CapturePollOptions {
  passiveWindowMs?: number;
  passiveDeadline?: number;
  requestFallback?: (remainingMs: number) => Promise<void>;
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
  const hits = capture?.hits || [];
  const match = hits.find((hit) =>
    hit.url === target &&
    hit.status === 200 &&
    isApprovedText(hit.text)
  );
  const requests = capture?.requests || {};
  return {
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
      await runBeforeDeadline((remainingMs) => options.requestFallback!(remainingMs));
      fallbackRequested = true;
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
  requestFallback: (remainingMs: number) => Promise<void>,
  passiveDeadline?: number,
): Promise<CapturePollResult> {
  return pollCaptureWithEvaluator(
    <T>(expression: string, timeoutLabel?: string) =>
      evaluate(expression, timeoutLabel) as Promise<T>,
    targetApiUrl,
    timeoutMs,
    { passiveWindowMs, passiveDeadline, requestFallback },
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
): Promise<string> {
  const parts: string[] = [];
  for (let start = 0; start < chars; start += chunkSize) {
    const end = Math.min(start + chunkSize, chars);
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
  const hits = window.__oracleChatGptBackendCapture?.hits || [];
  const hit = hits.find((item) => item.url === target && item.status === 200 && isApprovedText(item.text));
  const persisted = sessionStorage.getItem("__oracleChatGptBackendCapture:" + target);
  const text = isApprovedText(hit?.text) ? hit.text : (isApprovedText(persisted) ? persisted : null);
  if (!text) return null;
  return String(text).slice(${start}, ${end});
})()
`;
    let part: string | null = null;
    const chunkDeadline = Math.min(deadline ?? Number.POSITIVE_INFINITY, Date.now() + 15_000);
    while (Date.now() < chunkDeadline) {
      part = await runBeforeCaptureDeadline(chunkDeadline, () =>
        evaluate<string | null>(expression, "capture chunk"),
      );
      if (typeof part === "string") {
        break;
      }
      await runBeforeCaptureDeadline(chunkDeadline, (remainingMs) =>
        delay(Math.min(250, remainingMs)),
      );
    }
    if (typeof part !== "string") {
      throw new Error(`Missing captured text chunk ${start}:${end}`);
    }
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
): Promise<string> {
  return retrieveCapturedTextWithEvaluator(
    <T>(expression: string, timeoutLabel?: string) =>
      evaluateByValue<T>(Runtime, expression, timeoutLabel),
    targetApiUrl,
    chars,
    chunkSize,
    deadline,
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  await fs.writeFile(sumsPath, `${lines.join("\n")}\n`, "utf8");
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
  await fs.mkdir(outDir, { recursive: true });
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
  await fs.writeFile(rawBackendPath, rawText, "utf8");
  await writeJson(conversationPath, payload);
  await writeJson(payloadPath, payload);
  await fs.writeFile(markdownPath, markdownForPayload(payload), "utf8");
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
    };
  }
  const { client, targetId, tabUrl, tabTitle, recovery } = resolved;
  let archiveRestored = false;
  try {
    const { Page, Runtime } = client;
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
    await Page.addScriptToEvaluateOnNewDocument({
      source: buildScopedBackendCaptureHook(targetApiUrl, {
        targetUrl: options.targetUrl,
        accountDigest: expectedAccountDigest,
        workspaceDigest: expectedWorkspaceDigest,
      }),
    });
    await Page.enable();
    const captureDeadline = Date.now() + timeoutMs;
    await runBeforeCaptureDeadline(captureDeadline, () => Page.reload({ ignoreCache: true }));
    const capture = await pollCapture(
      Runtime,
      targetApiUrl,
      remainingCaptureBudget(captureDeadline),
    );
    await assertChatGptExportMutationAffinity(
      Runtime,
      expectedAccountDigest,
      options.targetUrl,
      "export capture",
      expectedWorkspaceDigest,
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
    );
    const backend = JSON.parse(rawText) as BackendConversation;
    if (backend.conversation_id !== conversationId) {
      throw new Error("Capture did not return the approved conversation id.");
    }
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
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; archive restore also failed`,
        );
      }
    }
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function finalizeCompletedOpenBrowserUseExport(
  connection: Pick<OpenBrowserUseConnection, "finalize">,
): Promise<BrowserRunWarning[] | undefined> {
  try {
    await connection.finalize(false);
    return undefined;
  } catch (error) {
    const detailMessage = error instanceof Error ? error.message : String(error);
    const details = error instanceof BrowserAutomationError ? error.details : undefined;
    return [
      {
        code: "obu-tab-finalize-failed",
        severity: "warning",
        message: `Export completed, but Oracle could not finalize its task-owned main-Chrome tab: ${detailMessage}`,
        ...(details ? { details: { ...details } } : {}),
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
  const removeTerminationHooks = registerOpenBrowserUseTerminationHooks({
    connection: () => connection ?? connectionReady,
    releaseLock: () => lock.release(),
    logger,
  });
  try {
    connectionReady = connectOpenBrowserUseTab({
      oracleSessionId: options.oracleSessionId
        ? `export-${options.oracleSessionId}`
        : `export-${conversationId}`,
      conversationUrl: options.targetUrl,
      timeoutMs,
      logger,
    });
    connection = await connectionReady;
    await prepareOpenBrowserUseConversationRoute({
      connection,
      expectation,
      targetUrl: options.targetUrl,
      logger,
    });
    routeRetained = true;
    const { Page, Runtime } = connection.client;
    await Page.addScriptToEvaluateOnNewDocument({
      source: buildScopedBackendCaptureHook(targetApiUrl, {
        targetUrl: options.targetUrl,
        accountDigest: options.accountDigest,
        workspaceDigest: options.workspaceDigest,
      }),
    });
    await Page.enable();
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
          }),
      },
    );
    const hit = capture.hit;
    if (!hit?.chars) {
      throw new Error("Capture did not return the approved conversation response.");
    }
    await assertChatGptIdentity(Runtime, expectation);
    if (!(await isExpectedConversationScope(Runtime, options.targetUrl, "current URL check"))) {
      throw new Error("Resolved OBU tab is not the approved target conversation.");
    }
    const currentUrl = options.targetUrl;
    const rawText = await retrieveCapturedText(
      Runtime,
      targetApiUrl,
      hit.chars,
      chunkSize,
      captureDeadline,
    );
    const backend = JSON.parse(rawText) as BackendConversation;
    if (backend.conversation_id !== conversationId) {
      throw new Error("Capture did not return the approved conversation id.");
    }
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
    let postExportArchive: BrowserArchiveResult | undefined;
    if (options.archiveAfterExport === true) {
      await assertChatGptIdentity(Runtime, expectation);
      await assertChatGptExportMutationAffinity(
        Runtime,
        options.accountDigest,
        options.targetUrl,
        "post-export archive",
        options.workspaceDigest,
      );
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
    const warnings = await finalizeCompletedOpenBrowserUseExport(connection);
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
    throw new BrowserAutomationError(
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
  } finally {
    removeTerminationHooks();
    await connection?.finalize(!completed && routeRetained).catch(() => undefined);
    await lock.release().catch(() => undefined);
  }
}
