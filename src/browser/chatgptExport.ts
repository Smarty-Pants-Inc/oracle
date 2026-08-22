import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserArchiveResult, ChromeClient } from "./types.js";
import { archiveChatGptConversation } from "./actions/archiveConversation.js";
import {
  assertChatGptTabOrigin,
  connectToExistingChatGptTab,
  DEFAULT_REMOTE_CHROME_HOST,
  DEFAULT_REMOTE_CHROME_PORT,
  isChatGptUrl,
  openChatGptTarget,
  type ChatGptTabConnection,
} from "./liveTabs.js";
import { delay } from "./utils.js";
import {
  bindRemoteChromeBrowserWebSocketEndpoint,
  resolveRemoteChromeBrowserIdentity,
} from "./profileState.js";
import { closeTab, connectToRemoteChromeTarget } from "./chromeLifecycle.js";
import { assertChatGptAccountAffinity, readChatGptAccountIdentity } from "./chatgptAccount.js";

const execFileAsync = promisify(execFile);
const WINDOWS_EXPORT_UNAVAILABLE_MESSAGE =
  "ChatGPT conversation export is disabled on Windows until owner-exclusive ACLs can be established and verified.";

const DEFAULT_EXPORT_TIMEOUT_MS = 45_000;
const EXPORT_CLEANUP_ALLOWANCE_MS = 1_000;

function assertValidExportChunkSize(chunkSize: number): void {
  if (!Number.isFinite(chunkSize) || !Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("ChatGPT export chunk size must be a finite positive integer.");
  }
}

function assertValidExportTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("ChatGPT export timeout must be a finite non-negative number.");
  }
}

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

export interface ChatGptConversationExportOptions {
  targetUrl: string;
  outDir: string;
  tabRef?: string;
  host?: string;
  port?: number;
  browserId?: string;
  browserWSEndpoint?: string;
  accountDigest?: string;
  expectedEmail?: string;
  timeoutMs?: number;
  chunkSize?: number;
  knownArchived?: boolean;
  archiveAfterExport?: boolean;
}

export interface ChatGptConversationExportObuOptions {
  targetUrl: string;
  outDir: string;
  sessionId?: string;
  tabId: string;
  timeoutMs?: number;
  chunkSize?: number;
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
}

export interface ChatGptArchiveRecoveryResult {
  attempted: boolean;
  recovered: boolean;
  status: "not-needed" | "read-only";
  getStatus?: number;
  archiveStatePreserved?: boolean;
}

interface ResolvedChatGptExportConnection {
  client: ChatGptTabConnection["client"];
  targetId: string;
  tabUrl: string;
  tabTitle: string;
  recovery: ChatGptArchiveRecoveryResult;
}

interface CaptureHitSummary {
  kind?: string;
  url?: string;
  status?: number;
  ok?: boolean;
  contentType?: string | null;
  chars?: number;
  conversation_id?: string | null;
  mappingCount?: number | null;
}

interface CapturePollResult {
  hit?: CaptureHitSummary | null;
  hits?: CaptureHitSummary[];
}
interface CaptureProvenance {
  captureRoute: string;
  extractionMethod: string;
  backendProbeMethod: string;
  limitation: string;
  manifestNonClaim: string;
}

const RELOAD_CAPTURE_PROVENANCE: CaptureProvenance = {
  captureRoute: "document-start-fetch-clone-on-reload",
  extractionMethod: "backend-fetch-capture-during-page-load",
  backendProbeMethod: "document_start_fetch_clone_on_reload",
  limitation:
    "Captures ChatGPT backend conversation JSON for the exact approved conversation id during the page's own load request.",
  manifestNonClaim:
    "The hook captured only the exact target backend conversation URL during page load.",
};

const EXACT_GET_CAPTURE_PROVENANCE: CaptureProvenance = {
  captureRoute: "authenticated-affinity-bound-exact-get",
  extractionMethod: "authenticated-affinity-bound-exact-get",
  backendProbeMethod: "authenticated-affinity-bound-exact-get",
  limitation:
    "Captures ChatGPT backend conversation JSON with an authenticated, account-affinity-bound exact GET for the approved conversation URL.",
  manifestNonClaim:
    "The authenticated, account-affinity-bound exact GET fetched only the exact target backend conversation URL.",
};

type EvaluateExpression = <T>(expression: string, timeoutLabel?: string) => Promise<T>;
async function runBeforeDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
  timeoutMessage: string,
): Promise<T> {
  const remaining = remainingMs(deadline);
  if (remaining <= 0) throw new Error(timeoutMessage);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function remainingMs(deadline: number): number {
  return Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : 0;
}

async function runCleanupBeforeDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
  timeoutMessage: string,
): Promise<T> {
  if (remainingMs(deadline) > 0) {
    return await runBeforeDeadline(operation, deadline, timeoutMessage);
  }
  void Promise.resolve()
    .then(operation)
    .catch(() => undefined);
  throw new Error(timeoutMessage);
}

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
      "target-url must be https://chatgpt.com/c/<conversation-id> or https://chatgpt.com/g/<project>/project/c/<conversation-id>",
    );
  }
  if (
    !isChatGptUrl(rawUrl) ||
    parsed.hostname.toLowerCase() !== "chatgpt.com" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "target-url must be https://chatgpt.com/c/<conversation-id> or https://chatgpt.com/g/<project>/project/c/<conversation-id>",
    );
  }
  const match = /^(?:\/c|\/g\/[^/?#]+\/(?:project\/)?c)\/([^/?#]+)\/?$/.exec(parsed.pathname);
  if (!match?.[1]) {
    throw new Error(
      "target-url must be a specific ChatGPT conversation URL: https://chatgpt.com/c/<conversation-id> or https://chatgpt.com/g/<project>/project/c/<conversation-id>",
    );
  }
  return match[1];
}

export function buildBackendConversationUrl(conversationId: string): string {
  return `https://chatgpt.com/backend-api/conversation/${conversationId}`;
}

export function isSameConversationUrl(actualUrl: string, expectedConversationId: string): boolean {
  try {
    return conversationIdFromChatGptUrl(actualUrl) === expectedConversationId;
  } catch {
    return false;
  }
}

async function assertChatGptExportAccountAffinity(
  Runtime: ChromeClient["Runtime"],
  expectedAccountDigest: string | undefined,
  action: string,
  expectedEmail: string | undefined,
  deadline: number,
): Promise<string> {
  await runBeforeDeadline(
    () => assertChatGptTabOrigin(Runtime, action),
    deadline,
    `Timed out validating ChatGPT export ${action} origin.`,
  );
  if (expectedAccountDigest && expectedEmail) {
    return await runBeforeDeadline(
      () =>
        assertChatGptAccountAffinity(
          Runtime,
          expectedAccountDigest,
          expectedEmail,
          action,
          remainingMs(deadline),
        ),
      deadline,
      `Timed out validating ChatGPT export ${action} account affinity.`,
    );
  }
  const observed = await runBeforeDeadline(
    () => readChatGptAccountIdentity(Runtime, remainingMs(deadline)),
    deadline,
    `Timed out reading ChatGPT export ${action} account identity.`,
  );
  if (expectedAccountDigest && observed.accountDigest !== expectedAccountDigest) {
    throw new Error(`Remote Chrome account identity changed before ${action}.`);
  }
  return observed.accountDigest;
}

async function assertChatGptExportCaptureAffinity(
  Runtime: ChromeClient["Runtime"],
  expectedAccountDigest: string,
  conversationId: string,
  action: string,
  expectedEmail: string | undefined,
  deadline: number,
): Promise<void> {
  await assertChatGptExportAccountAffinity(
    Runtime,
    expectedAccountDigest,
    action,
    expectedEmail,
    deadline,
  );
  const currentUrl = await evaluateByValue<string>(
    Runtime,
    "location.href",
    "conversation URL",
    deadline,
  );
  if (!isSameConversationUrl(currentUrl, conversationId)) {
    throw new Error(`ChatGPT conversation changed before ${action}.`);
  }
}

async function assertChatGptExportMutationAffinity(
  Runtime: ChromeClient["Runtime"],
  expectedAccountDigest: string | undefined,
  conversationId: string,
  action: string,
  expectedEmail: string | undefined,
  deadline: number,
): Promise<void> {
  if (!expectedAccountDigest || !expectedEmail) {
    throw new Error(`Complete ChatGPT account affinity is required before ${action}.`);
  }
  await assertChatGptExportCaptureAffinity(
    Runtime,
    expectedAccountDigest,
    conversationId,
    action,
    expectedEmail,
    deadline,
  );
}

export async function assertChatGptExportMutationAffinityForTest(
  Runtime: ChromeClient["Runtime"],
  expectedAccountDigest: string | undefined,
  conversationId: string,
  action = "archive mutation",
  expectedEmail?: string,
): Promise<void> {
  await assertChatGptExportMutationAffinity(
    Runtime,
    expectedAccountDigest,
    conversationId,
    action,
    expectedEmail,
    Date.now() + DEFAULT_EXPORT_TIMEOUT_MS,
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

export function buildScopedBackendCaptureHook(targetApiUrl: string): string {
  return `
(() => {
  const TARGET = ${jsString(targetApiUrl)};
  if (window !== window.top) return;
  try { window.__oracleChatGptBackendCapture?.cleanup?.(); } catch {}
  const originalFetch = window.fetch;
  const OriginalXHR = window.XMLHttpRequest;
  let active = true;
  const capture = { target: TARGET, hits: [], cleanup: null };
  const record = async (kind, input, response) => {
    try {
      const url = new URL(typeof input === "string" ? input : (input && input.url) || "", location.href).href;
      if (url !== TARGET) return;
      const text = await response.clone().text();
      if (!active) return;
      try {
        sessionStorage.setItem("__oracleChatGptBackendCapture:" + TARGET, text);
      } catch {}
      capture.hits.push({
        kind,
        url,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type"),
        chars: text.length,
        text,
        capturedAt: new Date().toISOString()
      });
    } catch (error) {
      if (active) capture.hits.push({ kind, error: String(error), capturedAt: new Date().toISOString() });
    }
  };
  const wrappedFetch = async function(input, init) {
    const response = await originalFetch.apply(this, arguments);
    void record("fetch", input, response);
    return response;
  };
  wrappedFetch.__oracleChatGptBackendCaptureTarget = TARGET;
  const WrappedXHR = function() {
    const xhr = new OriginalXHR();
    let requestUrl = "";
    const open = xhr.open;
    xhr.open = function(method, url) {
      requestUrl = String(url || "");
      return open.apply(xhr, arguments);
    };
    xhr.addEventListener("loadend", () => {
      try {
        const href = new URL(requestUrl, location.href).href;
        if (!active || href !== TARGET) return;
        const text = String(xhr.responseText || "");
        try {
          sessionStorage.setItem("__oracleChatGptBackendCapture:" + TARGET, text);
        } catch {}
        capture.hits.push({
          kind: "xhr",
          url: href,
          status: xhr.status,
          ok: xhr.status >= 200 && xhr.status < 300,
          contentType: xhr.getResponseHeader("content-type"),
          chars: text.length,
          text,
          capturedAt: new Date().toISOString()
        });
      } catch {}
    });
    return xhr;
  };
  WrappedXHR.__oracleChatGptBackendCaptureTarget = TARGET;
  capture.cleanup = () => {
    active = false;
    if (window.fetch === wrappedFetch) window.fetch = originalFetch;
    if (window.XMLHttpRequest === WrappedXHR) window.XMLHttpRequest = OriginalXHR;
    for (const hit of capture.hits) {
      if (hit && typeof hit === "object") delete hit.text;
    }
    capture.hits.length = 0;
    try { sessionStorage.removeItem("__oracleChatGptBackendCapture:" + TARGET); } catch {}
    if (window.__oracleChatGptBackendCapture === capture) {
      delete window.__oracleChatGptBackendCapture;
    }
  };
  window.__oracleChatGptBackendCapture = capture;
  window.fetch = wrappedFetch;
  window.XMLHttpRequest = WrappedXHR;
})();
`.trim();
}

function buildCaptureCleanupExpression(targetApiUrl: string): string {
  return `
(() => {
  const TARGET = ${jsString(targetApiUrl)};
  const CAPTURE_KEY = "__oracleChatGptBackendCapture:" + TARGET;
  const WRAPPER_MARKER = "__oracleChatGptBackendCaptureTarget";
  const capture = window.__oracleChatGptBackendCapture;
  try { capture?.cleanup?.(); } catch {}
  if (Array.isArray(capture?.hits)) {
    for (const hit of capture.hits) {
      if (hit && typeof hit === "object") delete hit.text;
    }
    capture.hits.length = 0;
  }
  let storageCleared = false;
  try {
    sessionStorage.removeItem(CAPTURE_KEY);
    storageCleared = sessionStorage.getItem(CAPTURE_KEY) === null;
  } catch {}
  if (window.__oracleChatGptBackendCapture === capture) {
    delete window.__oracleChatGptBackendCapture;
  }
  const globalCleared = typeof window.__oracleChatGptBackendCapture === "undefined";
  const fetchRestored = window.fetch?.[WRAPPER_MARKER] !== TARGET;
  const xhrRestored = window.XMLHttpRequest?.[WRAPPER_MARKER] !== TARGET;
  return globalCleared && storageCleared && fetchRestored && xhrRestored;
})()
`.trim();
}

export function buildChatGptCaptureCleanupExpressionForTest(targetApiUrl: string): string {
  return buildCaptureCleanupExpression(targetApiUrl);
}

export function buildReadOnlyConversationGetExpressionForTest(
  targetApiUrl: string,
  expectedAccountDigest?: string,
  expectedEmail?: string,
  remainingMs = DEFAULT_EXPORT_TIMEOUT_MS,
): string {
  const url = new URL(targetApiUrl);
  const prefix = "/backend-api/conversation/";
  if (
    url.origin !== "https://chatgpt.com" ||
    !url.pathname.startsWith(prefix) ||
    url.pathname.length === prefix.length ||
    url.search ||
    url.hash
  ) {
    throw new Error("Expected an exact ChatGPT backend conversation URL.");
  }
  return buildReadOnlyConversationGetExpression(
    targetApiUrl,
    decodeURIComponent(url.pathname.slice(prefix.length)),
    expectedAccountDigest,
    expectedEmail,
    remainingMs,
  );
}

function buildReadOnlyConversationGetExpression(
  targetApiUrl: string,
  expectedConversationId: string,
  expectedAccountDigest: string | undefined,
  expectedEmail: string | undefined,
  remainingMs: number,
): string {
  const pageBudgetMs = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : 0;
  return `
(async () => {
  const TARGET = ${jsString(targetApiUrl)};
  const EXPECTED_CONVERSATION_ID = ${jsString(expectedConversationId)};
  const EXPECTED_ACCOUNT_DIGEST = ${JSON.stringify(expectedAccountDigest ?? null)};
  const EXPECTED_EMAIL = ${JSON.stringify(expectedEmail?.trim().toLowerCase() || null)};
  const REMAINING_MS = ${JSON.stringify(pageBudgetMs)};
  const DEADLINE = Date.now() + REMAINING_MS;
  const timeoutError = () => new Error("Authenticated ChatGPT exact GET timed out.");
  const requestWithinDeadline = async (input, init, readBody) => {
    const remaining = DEADLINE - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw timeoutError();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      return { response, body: await readBody(response) };
    } catch (error) {
      if (controller.signal.aborted || Date.now() >= DEADLINE) throw timeoutError();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
  const digestUserId = async (userId) => {
    if (typeof userId !== "string" || !userId.trim() || !globalThis.crypto?.subtle) return null;
    const bytes = new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(userId.trim()),
    ));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const sessionIdentity = async (session) => {
    const userId = typeof session?.user?.id === "string" ? session.user.id.trim() : "";
    const email = typeof session?.user?.email === "string"
      ? session.user.email.trim().toLowerCase()
      : "";
    const accountDigest = await digestUserId(userId);
    return accountDigest && email ? { accountDigest, email } : null;
  };
  const bearerIdentity = async (accessToken) => {
    try {
      const match = /^([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)$/.exec(accessToken);
      if (!match) return null;
      const encoded = match[2].replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
      const auth = payload?.["https://api.openai.com/auth"];
      const profile = payload?.["https://api.openai.com/profile"];
      const userIds = [auth?.chatgpt_user_id, auth?.user_id]
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim());
      const email = typeof profile?.email === "string" ? profile.email.trim().toLowerCase() : "";
      if (!email || userIds.length === 0 || userIds.some((value) => value !== userIds[0])) return null;
      const accountDigest = await digestUserId(userIds[0]);
      return accountDigest ? { accountDigest, email } : null;
    } catch {
      return null;
    }
  };
  const { body: session } = await requestWithinDeadline(
    "/api/auth/session",
    {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      redirect: "error"
    },
    async (response) => {
      if (!response.ok) throw new Error("Authenticated ChatGPT session is unavailable.");
      return await response.json();
    },
  );
  const accessToken = typeof session?.accessToken === "string" ? session.accessToken.trim() : "";
  if (!accessToken) throw new Error("Authenticated ChatGPT access token is unavailable.");
  const cookieIdentity = await sessionIdentity(session);
  const tokenIdentity = await bearerIdentity(accessToken);
  if (
    !cookieIdentity ||
    !tokenIdentity ||
    cookieIdentity.accountDigest !== tokenIdentity.accountDigest ||
    cookieIdentity.email !== tokenIdentity.email ||
    (EXPECTED_ACCOUNT_DIGEST && tokenIdentity.accountDigest !== EXPECTED_ACCOUNT_DIGEST) ||
    (EXPECTED_EMAIL && tokenIdentity.email !== EXPECTED_EMAIL)
  ) {
    throw new Error("Authenticated ChatGPT bearer identity does not match the approved account.");
  }
  const headers = new Headers({ accept: "application/json" });
  headers.set("authorization", "Bearer " + accessToken);
  const { response, body: text } = await requestWithinDeadline(
    TARGET,
    {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      redirect: "error",
      headers
    },
    async (response) => await response.text(),
  );
  const responseUrl = new URL(response.url, location.href).href;
  if (response.redirected || responseUrl !== TARGET) {
    throw new Error("Authenticated ChatGPT exact GET left the approved backend URL.");
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  const conversationId = typeof parsed?.conversation_id === "string" ? parsed.conversation_id : null;
  if (!response.ok || response.status !== 200 || conversationId !== EXPECTED_CONVERSATION_ID) {
    throw new Error("Authenticated ChatGPT exact GET did not return the approved conversation.");
  }
  const hit = {
    kind: "authenticated-exact-get",
    url: responseUrl,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type"),
    chars: text.length,
    title: typeof parsed?.title === "string" ? parsed.title : null,
    conversation_id: conversationId,
    mappingCount: parsed?.mapping && typeof parsed.mapping === "object"
      ? Object.keys(parsed.mapping).length
      : null,
    current_node: typeof parsed?.current_node === "string" ? parsed.current_node : null
  };
  window.__oracleChatGptBackendCapture = {
    target: TARGET,
    hits: [{ ...hit, text, capturedAt: new Date().toISOString() }]
  };
  return hit;
})()
`.trim();
}

async function waitForDocument(Runtime: ChromeClient["Runtime"], deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    const ready = await evaluateByValue<string>(
      Runtime,
      "document.readyState",
      "document ready",
      deadline,
    );
    const href = await evaluateByValue<string>(Runtime, "location.href", "document URL", deadline);
    if (isChatGptUrl(href) && (ready === "interactive" || ready === "complete")) return;
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error("Timed out waiting for ChatGPT document readiness.");
}

async function waitForConversationUrl(
  Runtime: ChromeClient["Runtime"],
  conversationId: string,
  deadline: number,
): Promise<string> {
  let lastUrl = "";
  while (Date.now() < deadline) {
    lastUrl = await evaluateByValue<string>(Runtime, "location.href", "conversation URL", deadline);
    if (isSameConversationUrl(lastUrl, conversationId)) return lastUrl;
    await delay(Math.min(150, remainingMs(deadline)));
  }
  throw new Error("Conversation did not open at the approved URL.");
}

async function closeOpenedChatGptTarget(
  host: string,
  port: number,
  targetId: string,
  deadline: number,
  browserWSEndpoint?: string,
): Promise<void> {
  if (browserWSEndpoint) {
    const connection = await runCleanupBeforeDeadline(
      () =>
        connectToRemoteChromeTarget(host, port, () => {}, {
          browserWSEndpoint,
          targetId,
          closeTargetOnDispose: true,
        }),
      deadline,
      "Timed out reconnecting to clean up the ChatGPT export target.",
    );
    await runCleanupBeforeDeadline(
      () => connection.close(),
      deadline,
      "Timed out closing the ChatGPT export target.",
    );
    return;
  }
  const closed = await runCleanupBeforeDeadline(
    () => closeTab(port, targetId, () => {}, host),
    deadline,
    "Timed out closing the ChatGPT export target.",
  );
  if (!closed) {
    throw new Error("ChatGPT target cleanup was not confirmed.");
  }
}

async function evaluateByValue<T>(
  Runtime: ChromeClient["Runtime"],
  expression: string,
  timeoutLabel = "Runtime.evaluate",
  deadline?: number,
): Promise<T> {
  const evaluate = () =>
    Runtime.evaluate({
      expression,
      awaitPromise: false,
      returnByValue: true,
    });
  const result =
    deadline === undefined
      ? await evaluate()
      : await runBeforeDeadline(evaluate, deadline, `Timed out waiting for ${timeoutLabel}.`);
  if (result.exceptionDetails) {
    throw new Error(`${timeoutLabel} failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result?.value as T;
}

async function runObuCdp(
  sessionId: string,
  tabId: string,
  method: string,
  params: JsonRecord,
  deadline: number,
  cleanup = false,
): Promise<JsonRecord> {
  const timeout = `${Math.max(1, Math.ceil(remainingMs(deadline) / 1_000))}s`;
  const run = () =>
    execFileAsync(
      "obu",
      [
        "cdp",
        "--session-id",
        sessionId,
        "--tab-id",
        tabId,
        "--method",
        method,
        "--params",
        JSON.stringify(params),
        "--timeout",
        timeout,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
  const { stdout, stderr } = cleanup
    ? await runCleanupBeforeDeadline(run, deadline, `Timed out waiting for obu cdp ${method}.`)
    : await runBeforeDeadline(run, deadline, `Timed out waiting for obu cdp ${method}.`);
  let envelope: JsonRecord;
  try {
    envelope = JSON.parse(stdout) as JsonRecord;
  } catch (error) {
    throw new Error(
      `obu cdp ${method} returned non-JSON output: ${stderr || stdout || String(error)}`,
    );
  }
  if (envelope.error) {
    throw new Error(`obu cdp ${method} failed: ${JSON.stringify(envelope.error)}`);
  }
  return asRecord(envelope.result);
}

async function evaluateObuByValue<T>(
  sessionId: string,
  tabId: string,
  expression: string,
  deadline: number,
  timeoutLabel = "Runtime.evaluate",
  cleanup = false,
): Promise<T> {
  const result = await runObuCdp(
    sessionId,
    tabId,
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    deadline,
    cleanup,
  );
  if (result.exceptionDetails) {
    throw new Error(`${timeoutLabel} failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return asRecord(result.result).value as T;
}

function buildChatGptAccountDigestExpression(remainingMs: number): string {
  const pageBudgetMs = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : 0;
  return `(() => (async () => {
  const REMAINING_MS = ${JSON.stringify(pageBudgetMs)};
  if (REMAINING_MS <= 0) return null;
  const deadline = Date.now() + REMAINING_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMAINING_MS);
  try {
    const response = await fetch('/api/auth/session', {
      method: 'GET', cache: 'no-store', credentials: 'include', redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok || controller.signal.aborted || Date.now() >= deadline) return null;
    const body = await response.json();
    if (controller.signal.aborted || Date.now() >= deadline) return null;
    const userId = typeof body?.user?.id === 'string' ? body.user.id.trim() : '';
    if (!userId || !globalThis.crypto?.subtle) return null;
    const bytes = new Uint8Array(await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(userId),
    ));
    return controller.signal.aborted || Date.now() >= deadline
      ? null
      : Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
})())()`;
}

async function readChatGptAccountDigestWithEvaluator(
  evaluate: EvaluateExpression,
  remainingMs: number,
): Promise<string> {
  const digest = await evaluate<string | null>(
    buildChatGptAccountDigestExpression(remainingMs),
    "ChatGPT account identity",
  );
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Authenticated ChatGPT account identity is unavailable.");
  }
  return digest;
}

async function cleanupCaptureWithEvaluator(
  evaluate: EvaluateExpression,
  targetApiUrl: string,
): Promise<void> {
  const cleaned = await evaluate<boolean>(
    buildCaptureCleanupExpression(targetApiUrl),
    "capture cleanup",
  );
  if (cleaned !== true) {
    throw new Error("ChatGPT raw capture cleanup could not be verified.");
  }
}

function captureHitDiagnostics(value: unknown): JsonRecord | null {
  const hit = asRecord(value);
  if (Object.keys(hit).length === 0) return null;
  const diagnostics: JsonRecord = {};
  for (const key of ["kind", "status", "ok", "contentType", "chars", "mappingCount"]) {
    const item = hit[key];
    if (item == null || ["string", "number", "boolean"].includes(typeof item)) {
      diagnostics[key] = item;
    }
  }
  return diagnostics;
}

function capturePollTimeoutMessage(value: unknown): string {
  const poll = asRecord(value);
  const hits = Array.isArray(poll.hits) ? poll.hits : [];
  const diagnostics: JsonRecord = {
    hit: captureHitDiagnostics(poll.hit),
    hitCount: hits.length,
    hits: hits.map(captureHitDiagnostics).filter((hit) => hit !== null),
  };
  return `Timed out waiting for backend conversation capture: ${JSON.stringify(diagnostics)}`;
}

export function formatChatGptCaptureTimeoutForTest(value: unknown): string {
  return capturePollTimeoutMessage(value);
}

async function pollCaptureWithEvaluator(
  evaluate: EvaluateExpression,
  targetApiUrl: string,
  deadline: number,
): Promise<CapturePollResult> {
  let last: CapturePollResult = {};
  const expression = `
(() => {
  const target = ${jsString(targetApiUrl)};
  const hits = window.__oracleChatGptBackendCapture?.hits || [];
  const summaries = hits.map((hit) => {
    const text = String(hit.text || "");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return {
      kind: hit.kind,
      url: hit.url,
      status: hit.status,
      ok: hit.ok,
      contentType: hit.contentType,
      chars: text.length,
      conversation_id: parsed?.conversation_id || null,
      mappingCount: parsed?.mapping ? Object.keys(parsed.mapping).length : null
    };
  });
  const match = summaries.find((hit) => hit.url === target && hit.status === 200 && hit.conversation_id);
  return { hit: match || null, hits: summaries };
})()
`;
  while (Date.now() < deadline) {
    last = await evaluate<CapturePollResult>(expression, "capture poll");
    if (last?.hit) {
      return last;
    }
    await delay(Math.min(1_000, remainingMs(deadline)));
  }
  throw new Error(capturePollTimeoutMessage(last));
}

async function pollCapture(
  Runtime: ChromeClient["Runtime"],
  targetApiUrl: string,
  deadline: number,
): Promise<CapturePollResult> {
  return await pollCaptureWithEvaluator(
    <T>(expression: string, timeoutLabel?: string) =>
      evaluateByValue<T>(Runtime, expression, timeoutLabel, deadline),
    targetApiUrl,
    deadline,
  );
}

export async function retrieveCapturedTextWithEvaluator(
  evaluate: EvaluateExpression,
  targetApiUrl: string,
  chars: number,
  chunkSize: number,
  deadline?: number,
): Promise<string> {
  assertValidExportChunkSize(chunkSize);
  const parts: string[] = [];
  for (let start = 0; start < chars; start += chunkSize) {
    const end = Math.min(start + chunkSize, chars);
    const expression = `
(() => {
  const target = ${jsString(targetApiUrl)};
  const capture = window.__oracleChatGptBackendCapture;
  const hits = capture?.hits || [];
  const hit = hits.find((item) => item.url === target && item.status === 200 && String(item.text || "").startsWith("{"));
  const text = hit?.text || sessionStorage.getItem("__oracleChatGptBackendCapture:" + target);
  if (!text || !String(text).startsWith("{")) return null;
  const chunk = String(text).slice(${start}, ${end});
  return chunk;
})()
`;
    let part: string | null = null;
    const chunkDeadline = deadline ?? Date.now() + 15_000;
    while (Date.now() < chunkDeadline) {
      part = await evaluate<string | null>(expression, "capture chunk");
      if (typeof part === "string") {
        break;
      }
      await delay(Math.min(250, Math.max(0, chunkDeadline - Date.now())));
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
      evaluateByValue<T>(Runtime, expression, timeoutLabel, deadline),
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
  provenance: CaptureProvenance = RELOAD_CAPTURE_PROVENANCE,
): JsonRecord {
  const mapping = backend.mapping ?? {};
  const currentPath = pathFromMapping(mapping, backend.current_node);
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
    capture_route: provenance.captureRoute,
    extraction_method: provenance.extractionMethod,
    limitations: [
      provenance.limitation,
      "Does not read browser cookies, localStorage, profile stores, or unrelated conversation history.",
      "Includes backend-only nodes such as tool events, thoughts, reasoning recaps, and hidden/system messages when present in the conversation payload.",
      "Does not claim real-world authorship or content beyond the captured ChatGPT backend payload.",
    ],
    backend_probe: {
      attempted: true,
      method: provenance.backendProbeMethod,
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
    `- Capture route: ${payload.capture_route ?? ""}`,
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

async function isExistingRealDirectory(directory: string): Promise<boolean> {
  try {
    const info = await fs.lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(
        "ChatGPT export destination parent components must be real directories, not symlinks.",
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensurePrivateOutputDirectory(outDir: string): Promise<void> {
  if (process.platform === "win32") {
    throw new Error(WINDOWS_EXPORT_UNAVAILABLE_MESSAGE);
  }
  const absoluteOutDir = path.resolve(outDir);
  const parentDir = path.dirname(absoluteOutDir);
  const { root } = path.parse(absoluteOutDir);
  let current = root;
  for (const component of parentDir.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (await isExistingRealDirectory(current)) continue;
    let created = false;
    try {
      await fs.mkdir(current, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await isExistingRealDirectory(current))) {
      throw new Error("ChatGPT export destination parent disappeared during creation.");
    }
    if (created) await fs.chmod(current, 0o700);
  }

  try {
    await fs.mkdir(absoluteOutDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "ChatGPT export destination must be a fresh path that does not already exist.",
      );
    }
    throw error;
  }
  const info = await fs.lstat(absoluteOutDir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("ChatGPT export destination must be a real directory, not a symlink.");
  }
  await fs.chmod(absoluteOutDir, 0o700);
}

async function writePrivateFile(filePath: string, value: string): Promise<void> {
  const file = await fs.open(filePath, "wx", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(value, "utf8");
  } finally {
    await file.close();
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writePrivateFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
  await writePrivateFile(sumsPath, `${lines.join("\n")}\n`);
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
  await ensurePrivateOutputDirectory(outDir);
  try {
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
    await writePrivateFile(rawBackendPath, rawText);
    await writeJson(conversationPath, payload);
    await writeJson(payloadPath, payload);
    await writePrivateFile(markdownPath, markdownForPayload(payload));
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
      capture_route: payload.capture_route,
      turn_count: stats.turn_count,
      user_turns: stats.user_turns,
      assistant_turns: stats.assistant_turns,
      tool_turns: stats.tool_turns,
      system_turns: stats.system_turns,
      stats,
      backend_probe: payload.backend_probe,
      files,
      non_claims: [
        "No cookies, localStorage, profile stores, or unrelated history were read.",
        payload.capture_route === EXACT_GET_CAPTURE_PROVENANCE.captureRoute
          ? EXACT_GET_CAPTURE_PROVENANCE.manifestNonClaim
          : RELOAD_CAPTURE_PROVENANCE.manifestNonClaim,
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
  } catch (error) {
    try {
      await fs.rm(outDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "ChatGPT export bundle creation and partial-output cleanup failed.",
      );
    }
    throw error;
  }
}

export const writeChatGptExportBundleForTest = writeBundle;

async function finalizeCapturedExport({
  backend,
  rawText,
  targetUrl,
  targetApiUrl,
  outDir,
  targetId,
  tabUrl,
  provenance = RELOAD_CAPTURE_PROVENANCE,
  captureInfo,
}: {
  backend: BackendConversation;
  rawText: string;
  targetUrl: string;
  targetApiUrl: string;
  outDir: string;
  targetId: string;
  tabUrl: string;
  provenance?: CaptureProvenance;
  captureInfo: JsonRecord;
}): Promise<Omit<ChatGptConversationExportResult, "archiveRecovery" | "postExportArchive">> {
  const conversationId = conversationIdFromChatGptUrl(targetUrl);
  if (backend.conversation_id !== conversationId) {
    throw new Error("Captured backend data did not match the approved conversation.");
  }
  const rawBackendSha256 = hashText(rawText);
  const rawBackendSizeBytes = Buffer.byteLength(rawText, "utf8");
  const payload = backendToPayload(
    backend,
    targetUrl,
    rawBackendSha256,
    rawBackendSizeBytes,
    provenance,
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
async function disposeChatGptExportConnection(
  client: ChromeClient,
  deadline: number,
): Promise<void> {
  await runCleanupBeforeDeadline(
    () => client.close(),
    deadline,
    "Timed out closing the ChatGPT export connection.",
  );
}

async function evaluateReadOnlyConversationGet(
  Runtime: ChromeClient["Runtime"],
  targetApiUrl: string,
  conversationId: string,
  expectedAccountDigest: string,
  expectedEmail: string | undefined,
  deadline: number,
): Promise<CaptureHitSummary> {
  const outcome = await runBeforeDeadline(
    () =>
      Runtime.evaluate({
        expression: buildReadOnlyConversationGetExpression(
          targetApiUrl,
          conversationId,
          expectedAccountDigest,
          expectedEmail,
          remainingMs(deadline),
        ),
        awaitPromise: true,
        returnByValue: true,
      }),
    deadline,
    "Timed out waiting for authenticated ChatGPT exact GET.",
  );
  if (outcome.exceptionDetails) {
    throw new Error(
      `Read-only conversation GET failed: ${JSON.stringify(outcome.exceptionDetails)}`,
    );
  }
  const hit = outcome.result?.value;
  if (!hit || typeof hit !== "object" || Array.isArray(hit)) {
    throw new Error("Read-only conversation GET returned no response metadata.");
  }
  return hit as CaptureHitSummary;
}

async function captureChatGptConversationReadOnly({
  targetUrl,
  targetApiUrl,
  outDir,
  host,
  port,
  browserId,
  browserWSEndpoint,
  accountDigest,
  expectedEmail,
  deadline,
  chunkSize,
}: {
  targetUrl: string;
  targetApiUrl: string;
  outDir: string;
  host: string;
  port: number;
  browserId: string;
  browserWSEndpoint: string;
  accountDigest: string;
  expectedEmail?: string;
  deadline: number;
  chunkSize: number;
}): Promise<ChatGptConversationExportResult> {
  const conversationId = conversationIdFromChatGptUrl(targetUrl);
  const boundIdentity = bindRemoteChromeBrowserWebSocketEndpoint({
    browserWSEndpoint,
    host,
    port,
  });
  if (boundIdentity.browserId !== browserId) {
    throw new Error("Read-only ChatGPT export browser id does not match its WebSocket.");
  }
  const opened = await runBeforeDeadline(
    () =>
      connectToRemoteChromeTarget(host, port, () => {}, {
        browserWSEndpoint: boundIdentity.browserWSEndpoint,
        targetUrl: "https://chatgpt.com/",
        closeTargetOnDispose: true,
      }),
    deadline,
    "Timed out connecting to the read-only ChatGPT export target.",
  );
  const targetId = opened.targetId;

  let completedResult: ChatGptConversationExportResult | undefined;
  let operationError: unknown;
  let captureCleanupRequired = false;
  try {
    if (!targetId || opened.browserWSEndpoint !== boundIdentity.browserWSEndpoint) {
      throw new Error("Read-only ChatGPT export target identity changed during connection.");
    }
    const { Page, Runtime } = opened.client;
    await runBeforeDeadline(
      () => Page.enable(),
      deadline,
      "Timed out preparing the read-only ChatGPT export target.",
    );
    await waitForDocument(Runtime, deadline);
    const tabUrl = await evaluateByValue<string>(
      Runtime,
      "location.href",
      "export target URL",
      deadline,
    );
    const tabTitle = await evaluateByValue<string>(
      Runtime,
      "document.title",
      "export target title",
      deadline,
    );

    await assertChatGptExportAccountAffinity(
      Runtime,
      accountDigest,
      "ChatGPT export exact GET",
      expectedEmail,
      deadline,
    );

    let hit: CaptureHitSummary | undefined;
    let getError: unknown;
    captureCleanupRequired = true;
    try {
      hit = await evaluateReadOnlyConversationGet(
        Runtime,
        targetApiUrl,
        conversationId,
        accountDigest,
        expectedEmail,
        deadline,
      );
    } catch (error) {
      getError = error;
    }
    let postGetAffinityError: unknown;
    if (Date.now() < deadline) {
      try {
        await assertChatGptExportAccountAffinity(
          Runtime,
          accountDigest,
          "ChatGPT export exact GET completion",
          expectedEmail,
          deadline,
        );
      } catch (error) {
        postGetAffinityError = error;
      }
    }
    if (getError && postGetAffinityError) {
      throw new AggregateError(
        [getError, postGetAffinityError],
        "Read-only conversation GET and post-GET account validation failed.",
      );
    }
    if (getError) throw getError;
    if (postGetAffinityError) throw postGetAffinityError;
    if (
      !hit ||
      hit.url !== targetApiUrl ||
      hit.status !== 200 ||
      hit.ok !== true ||
      hit.conversation_id !== conversationId ||
      typeof hit.chars !== "number" ||
      !Number.isSafeInteger(hit.chars) ||
      hit.chars <= 0
    ) {
      throw new Error(
        `Read-only conversation GET did not return the approved conversation: ${JSON.stringify(captureHitDiagnostics(hit))}`,
      );
    }

    const rawText = await retrieveCapturedText(
      Runtime,
      targetApiUrl,
      hit.chars,
      chunkSize,
      deadline,
    );
    const backend = JSON.parse(rawText) as BackendConversation;
    const result = await finalizeCapturedExport({
      backend,
      rawText,
      targetUrl,
      targetApiUrl,
      outDir,
      targetId,
      tabUrl,
      provenance: EXACT_GET_CAPTURE_PROVENANCE,
      captureInfo: {
        captured_at: new Date().toISOString(),
        target_url: targetUrl,
        target_api_url: targetApiUrl,
        capture_method: "authenticated-affinity-bound-exact-get",
        archive_state_preserved: true,
        tab: {
          host,
          port,
          target_id: targetId,
          url_before_get: tabUrl,
          title_before_get: tabTitle,
        },
        hit,
        non_claims: [
          "No cookie values, localStorage, profile stores, or unrelated ChatGPT history were read.",
          "The conversation was fetched only from the exact approved backend URL through a verified authenticated page context.",
          "Cookie and bearer JWT account affinity were validated inside the exact GET expression, the returned conversation id was exact, and no archive-state mutation was issued.",
        ],
      },
    });
    completedResult = {
      ...result,
      archiveRecovery: {
        attempted: false,
        recovered: false,
        status: "read-only",
        getStatus: hit.status,
        archiveStatePreserved: true,
      },
    };
  } catch (error) {
    operationError = error;
  }

  const cleanupDeadline = Date.now() + EXPORT_CLEANUP_ALLOWANCE_MS;
  const cleanupErrors: unknown[] = [];
  if (captureCleanupRequired) {
    try {
      await cleanupCaptureWithEvaluator(
        <T>(expression: string, timeoutLabel?: string) =>
          runCleanupBeforeDeadline(
            () => evaluateByValue<T>(opened.client.Runtime, expression, timeoutLabel),
            cleanupDeadline,
            `Timed out waiting for ${timeoutLabel ?? "capture cleanup"}.`,
          ),
        targetApiUrl,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await runCleanupBeforeDeadline(
      () => opened.close(),
      cleanupDeadline,
      "Timed out closing the read-only ChatGPT export target.",
    );
  } catch (error) {
    cleanupErrors.push(error);
  }
  const errors = operationError ? [operationError, ...cleanupErrors] : cleanupErrors;
  if (errors.length > 1) {
    throw new AggregateError(errors, "Read-only ChatGPT export and target cleanup failed.");
  }
  if (errors.length === 1) throw errors[0];
  if (!completedResult) throw new Error("Read-only ChatGPT export did not produce a result.");
  return completedResult;
}

export async function captureApprovedChatGptConversationBackend(
  options: ChatGptConversationExportOptions,
): Promise<ChatGptConversationExportResult> {
  if (process.platform === "win32") {
    throw new Error(WINDOWS_EXPORT_UNAVAILABLE_MESSAGE);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  assertValidExportTimeout(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const chunkSize = options.chunkSize ?? 250_000;
  assertValidExportChunkSize(chunkSize);
  const conversationId = conversationIdFromChatGptUrl(options.targetUrl);
  const targetApiUrl = buildBackendConversationUrl(conversationId);
  const host = options.host ?? DEFAULT_REMOTE_CHROME_HOST;
  const port = options.port ?? DEFAULT_REMOTE_CHROME_PORT;
  const expectedBrowserId = options.browserId?.trim();
  let browserWSEndpoint = options.browserWSEndpoint?.trim();
  const expectedAccountDigest = options.accountDigest?.trim();
  const expectedEmail = options.expectedEmail?.trim().toLowerCase();
  if (expectedBrowserId || browserWSEndpoint || expectedAccountDigest || expectedEmail) {
    if (!expectedBrowserId || !browserWSEndpoint || !expectedAccountDigest) {
      throw new Error(
        "ChatGPT export browser affinity requires browser id, WebSocket, and account identity.",
      );
    }
    const configuredIdentity = bindRemoteChromeBrowserWebSocketEndpoint({
      browserWSEndpoint,
      host,
      port,
    });
    if (configuredIdentity.browserId !== expectedBrowserId) {
      throw new Error("ChatGPT export browser id does not match its WebSocket.");
    }
    browserWSEndpoint = configuredIdentity.browserWSEndpoint;
    if (!/^[a-f0-9]{64}$/.test(expectedAccountDigest)) {
      throw new Error("ChatGPT export account identity is invalid.");
    }
    const liveIdentity = await runBeforeDeadline(
      () => resolveRemoteChromeBrowserIdentity({ host, port }),
      deadline,
      "Timed out resolving Remote Chrome browser identity before ChatGPT export.",
    );
    if (liveIdentity.browserId !== expectedBrowserId) {
      throw new Error("Remote Chrome browser identity changed before ChatGPT export.");
    }
    browserWSEndpoint = liveIdentity.browserWSEndpoint;
  }
  const readOnlyAccountAffinity =
    expectedBrowserId && browserWSEndpoint && expectedAccountDigest
      ? {
          browserId: expectedBrowserId,
          browserWSEndpoint,
          accountDigest: expectedAccountDigest,
          expectedEmail,
        }
      : undefined;
  if (options.knownArchived !== undefined && !readOnlyAccountAffinity) {
    throw new Error("Known ChatGPT archive state requires browser and account affinity.");
  }
  if (options.archiveAfterExport === true && (!readOnlyAccountAffinity || !expectedEmail)) {
    throw new Error("Post-export archiving requires complete ChatGPT account affinity.");
  }
  const tabRef = options.tabRef ?? options.targetUrl;
  const outDir = path.resolve(options.outDir);
  if (readOnlyAccountAffinity && options.archiveAfterExport !== true) {
    return await captureChatGptConversationReadOnly({
      targetUrl: options.targetUrl,
      targetApiUrl,
      outDir,
      host,
      port,
      browserId: readOnlyAccountAffinity.browserId,
      browserWSEndpoint: readOnlyAccountAffinity.browserWSEndpoint,
      accountDigest: readOnlyAccountAffinity.accountDigest,
      expectedEmail: readOnlyAccountAffinity.expectedEmail,
      deadline,
      chunkSize,
    });
  }
  let resolved: ResolvedChatGptExportConnection;
  try {
    const connected = await runBeforeDeadline(
      () =>
        connectToExistingChatGptTab({
          host,
          port,
          browserWSEndpoint,
          browserId: expectedBrowserId,
          accountDigest: expectedAccountDigest,
          ref: tabRef,
        }),
      deadline,
      "Timed out attaching to the approved ChatGPT export tab.",
    );
    if (!isSameConversationUrl(connected.tab.url, conversationId)) {
      await disposeChatGptExportConnection(
        connected.client,
        Date.now() + EXPORT_CLEANUP_ALLOWANCE_MS,
      ).catch(() => undefined);
      throw new Error("Resolved ChatGPT tab is not the approved target conversation.");
    }
    resolved = {
      client: connected.client,
      targetId: connected.targetId,
      tabUrl: connected.tab.url,
      tabTitle: connected.tab.title,
      recovery: { attempted: false, recovered: false, status: "not-needed" },
    };
  } catch (error) {
    if (options.knownArchived === false) {
      const targetId = await runBeforeDeadline(
        () =>
          openChatGptTarget({
            host,
            port,
            browserWSEndpoint,
            url: "https://chatgpt.com/",
          }),
        deadline,
        "Timed out creating the active ChatGPT export target.",
      );
      let opened: ChatGptTabConnection;
      try {
        opened = await runBeforeDeadline(
          () =>
            connectToExistingChatGptTab({
              host,
              port,
              browserWSEndpoint,
              browserId: expectedBrowserId,
              accountDigest: expectedAccountDigest,
              ref: targetId,
              closeTargetOnDispose: true,
            }),
          deadline,
          "Timed out attaching to the active ChatGPT export target.",
        );
      } catch (openError) {
        try {
          await closeOpenedChatGptTarget(
            host,
            port,
            targetId,
            Date.now() + EXPORT_CLEANUP_ALLOWANCE_MS,
            browserWSEndpoint,
          );
        } catch (closeError) {
          throw new AggregateError(
            [openError, closeError],
            "Active ChatGPT export setup and target cleanup failed.",
          );
        }
        throw openError;
      }
      try {
        const { Page, Runtime } = opened.client;
        await runBeforeDeadline(
          () => Page.enable(),
          deadline,
          "Timed out preparing the active ChatGPT export target.",
        );
        await waitForDocument(Runtime, deadline);
        await assertChatGptExportAccountAffinity(
          Runtime,
          expectedAccountDigest,
          "ChatGPT export navigation",
          expectedEmail,
          deadline,
        );
        await runBeforeDeadline(
          () => Page.navigate({ url: options.targetUrl }),
          deadline,
          "Timed out navigating the active ChatGPT export target.",
        );
        const tabUrl = await waitForConversationUrl(Runtime, conversationId, deadline);
        await waitForDocument(Runtime, deadline);
        resolved = {
          client: opened.client,
          targetId,
          tabUrl,
          tabTitle: opened.tab.title,
          recovery: { attempted: false, recovered: false, status: "not-needed" },
        };
      } catch (openError) {
        try {
          await disposeChatGptExportConnection(
            opened.client,
            Date.now() + EXPORT_CLEANUP_ALLOWANCE_MS,
          );
        } catch (closeError) {
          throw new AggregateError(
            [openError, closeError],
            "Active ChatGPT export navigation and target cleanup failed.",
          );
        }
        throw openError;
      }
    } else if (
      expectedBrowserId &&
      browserWSEndpoint &&
      expectedAccountDigest &&
      options.archiveAfterExport !== true
    ) {
      return await captureChatGptConversationReadOnly({
        targetUrl: options.targetUrl,
        targetApiUrl,
        outDir,
        host,
        port,
        browserId: expectedBrowserId,
        browserWSEndpoint,
        accountDigest: expectedAccountDigest,
        expectedEmail,
        deadline,
        chunkSize,
      });
    } else {
      const reason =
        options.archiveAfterExport === true
          ? "The approved conversation is not available in an existing tab, so --archive-after-export cannot be completed safely."
          : "The approved conversation is not available in an existing tab, and read-only fallback requires stored browser and account affinity.";
      throw new Error(`${reason} No archive-state changes were attempted.`, { cause: error });
    }
  }
  const { client, targetId, tabUrl, tabTitle, recovery } = resolved;
  const { Page, Runtime } = client;
  let completedResult: ChatGptConversationExportResult | undefined;
  let operationError: unknown;
  let pinnedAccountDigest: string | undefined;
  let captureScriptIdentifier: string | undefined;
  let rawCapturePending = false;
  try {
    pinnedAccountDigest = await assertChatGptExportAccountAffinity(
      Runtime,
      expectedAccountDigest,
      "ChatGPT export",
      expectedEmail,
      deadline,
    );
    const registration = await runBeforeDeadline(
      () =>
        Page.addScriptToEvaluateOnNewDocument({
          source: buildScopedBackendCaptureHook(targetApiUrl),
        }),
      deadline,
      "Timed out registering the ChatGPT export capture hook.",
    );
    captureScriptIdentifier = registration.identifier;
    rawCapturePending = true;
    await runBeforeDeadline(
      () => Page.enable(),
      deadline,
      "Timed out enabling the ChatGPT export target.",
    );
    await runBeforeDeadline(
      () => Page.reload({ ignoreCache: true }),
      deadline,
      "Timed out reloading the ChatGPT export target.",
    );
    const capture = await pollCapture(Runtime, targetApiUrl, deadline);
    const hit = capture.hit;
    if (!hit?.chars || hit.conversation_id !== conversationId) {
      throw new Error(
        `Capture did not return the approved conversation id: ${JSON.stringify(captureHitDiagnostics(hit))}`,
      );
    }
    const rawText = await retrieveCapturedText(
      Runtime,
      targetApiUrl,
      hit.chars,
      chunkSize,
      deadline,
    );
    if (captureScriptIdentifier) {
      await runBeforeDeadline(
        () => Page.removeScriptToEvaluateOnNewDocument({ identifier: captureScriptIdentifier! }),
        deadline,
        "Timed out removing the ChatGPT export capture hook.",
      );
      captureScriptIdentifier = undefined;
    }
    await cleanupCaptureWithEvaluator(
      <T>(expression: string, timeoutLabel?: string) =>
        evaluateByValue<T>(Runtime, expression, timeoutLabel, deadline),
      targetApiUrl,
    );
    rawCapturePending = false;
    await assertChatGptExportCaptureAffinity(
      Runtime,
      pinnedAccountDigest,
      conversationId,
      "ChatGPT export capture completion",
      expectedEmail,
      deadline,
    );
    const backend = JSON.parse(rawText) as BackendConversation;
    const result = await finalizeCapturedExport({
      backend,
      rawText,
      targetUrl: options.targetUrl,
      targetApiUrl,
      outDir,
      targetId,
      tabUrl,
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
        hit,
        non_claims: [
          "No cookie values, localStorage, profile stores, or unrelated history were read.",
          "The hook captured only the exact target backend conversation URL during page load.",
          options.archiveAfterExport === true
            ? "No archive-state mutation was issued during capture; a post-export archive was explicitly requested."
            : "No archive-state mutation was issued during or after capture.",
        ],
      },
    });
    let postExportArchive: BrowserArchiveResult | undefined;
    if (options.archiveAfterExport === true) {
      await assertChatGptExportMutationAffinity(
        Runtime,
        expectedAccountDigest,
        conversationId,
        "post-export archive",
        expectedEmail,
        deadline,
      );
      postExportArchive = await runBeforeDeadline(
        () =>
          archiveChatGptConversation(Runtime, () => {}, {
            mode: "always",
            conversationUrl: options.targetUrl,
            expectedAccountDigest,
            remainingMs: remainingMs(deadline),
          }),
        deadline,
        "Timed out archiving the exported ChatGPT conversation.",
      );
      if (!postExportArchive.archived) {
        throw new Error(`Post-export archive failed: ${JSON.stringify(postExportArchive)}`);
      }
    }
    completedResult = {
      ...result,
      archiveRecovery: recovery,
      postExportArchive,
    };
  } catch (error) {
    operationError = error;
  }
  const cleanupDeadline = Date.now() + EXPORT_CLEANUP_ALLOWANCE_MS;
  const cleanupErrors: unknown[] = [];
  if (captureScriptIdentifier) {
    try {
      await runCleanupBeforeDeadline(
        () => Page.removeScriptToEvaluateOnNewDocument({ identifier: captureScriptIdentifier! }),
        cleanupDeadline,
        "Timed out removing the ChatGPT export capture hook during cleanup.",
      );
      captureScriptIdentifier = undefined;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (rawCapturePending) {
    try {
      await cleanupCaptureWithEvaluator(
        <T>(expression: string, timeoutLabel?: string) =>
          runCleanupBeforeDeadline(
            () => evaluateByValue<T>(Runtime, expression, timeoutLabel),
            cleanupDeadline,
            `Timed out waiting for ${timeoutLabel ?? "capture cleanup"}.`,
          ),
        targetApiUrl,
      );
      rawCapturePending = false;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await disposeChatGptExportConnection(client, cleanupDeadline);
  } catch (error) {
    cleanupErrors.push(error);
  }
  const errors = operationError ? [operationError, ...cleanupErrors] : cleanupErrors;
  if (errors.length > 1) {
    throw new AggregateError(errors, "ChatGPT export and target cleanup failed.");
  }
  if (errors.length === 1) throw errors[0];
  if (!completedResult) throw new Error("ChatGPT export did not produce a result.");
  return completedResult;
}

export async function captureApprovedChatGptConversationBackendViaObu(
  options: ChatGptConversationExportObuOptions,
): Promise<ChatGptConversationExportResult> {
  if (process.platform === "win32") {
    throw new Error(WINDOWS_EXPORT_UNAVAILABLE_MESSAGE);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  assertValidExportTimeout(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const chunkSize = options.chunkSize ?? 250_000;
  assertValidExportChunkSize(chunkSize);
  const conversationId = conversationIdFromChatGptUrl(options.targetUrl);
  const targetApiUrl = buildBackendConversationUrl(conversationId);
  const sessionId = options.sessionId ?? "obu-mcp";
  const outDir = path.resolve(options.outDir);
  const evaluate: EvaluateExpression = <T>(expression: string, timeoutLabel?: string) =>
    evaluateObuByValue<T>(sessionId, options.tabId, expression, deadline, timeoutLabel);
  const currentUrl = await evaluate<string>("location.href", "current URL check");
  if (!isSameConversationUrl(currentUrl, conversationId)) {
    throw new Error("Resolved OBU tab is not the approved target conversation.");
  }
  const accountDigest = await readChatGptAccountDigestWithEvaluator(
    evaluate,
    remainingMs(deadline),
  );

  let completedResult: ChatGptConversationExportResult | undefined;
  let operationError: unknown;
  let captureScriptIdentifier: string | undefined;
  let rawCapturePending = false;
  try {
    const registration = await runObuCdp(
      sessionId,
      options.tabId,
      "Page.addScriptToEvaluateOnNewDocument",
      { source: buildScopedBackendCaptureHook(targetApiUrl) },
      deadline,
    );
    captureScriptIdentifier =
      typeof registration.identifier === "string" ? registration.identifier : undefined;
    if (!captureScriptIdentifier) {
      throw new Error("OBU capture hook registration did not return an identifier.");
    }
    rawCapturePending = true;
    await runObuCdp(sessionId, options.tabId, "Page.enable", {}, deadline);
    await runObuCdp(sessionId, options.tabId, "Page.reload", { ignoreCache: true }, deadline);
    const capture = await pollCaptureWithEvaluator(evaluate, targetApiUrl, deadline);
    const hit = capture.hit;
    if (!hit?.chars || hit.conversation_id !== conversationId) {
      throw new Error(
        `Capture did not return the approved conversation id: ${JSON.stringify(captureHitDiagnostics(hit))}`,
      );
    }
    const rawText = await retrieveCapturedTextWithEvaluator(
      evaluate,
      targetApiUrl,
      hit.chars,
      chunkSize,
      deadline,
    );
    await runObuCdp(
      sessionId,
      options.tabId,
      "Page.removeScriptToEvaluateOnNewDocument",
      { identifier: captureScriptIdentifier },
      deadline,
    );
    captureScriptIdentifier = undefined;
    await cleanupCaptureWithEvaluator(evaluate, targetApiUrl);
    rawCapturePending = false;
    const completionUrl = await evaluate<string>("location.href", "capture completion URL check");
    if (!isSameConversationUrl(completionUrl, conversationId)) {
      throw new Error("OBU conversation changed during capture.");
    }
    if (
      (await readChatGptAccountDigestWithEvaluator(evaluate, remainingMs(deadline))) !==
      accountDigest
    ) {
      throw new Error("Authenticated ChatGPT account identity changed during OBU capture.");
    }
    const backend = JSON.parse(rawText) as BackendConversation;
    const result = await finalizeCapturedExport({
      backend,
      rawText,
      targetUrl: options.targetUrl,
      targetApiUrl,
      outDir,
      targetId: `obu:${sessionId}:${options.tabId}`,
      tabUrl: currentUrl,
      captureInfo: {
        captured_at: new Date().toISOString(),
        target_url: options.targetUrl,
        target_api_url: targetApiUrl,
        tab: {
          transport: "obu",
          session_id: sessionId,
          tab_id: options.tabId,
          url_before_reload: currentUrl,
        },
        hit,
        non_claims: [
          "No cookies, localStorage, profile stores, or unrelated history were read.",
          "The hook captured only the exact target backend conversation URL during page load.",
        ],
      },
    });
    completedResult = {
      ...result,
      archiveRecovery: {
        attempted: false,
        recovered: false,
        status: "not-needed",
      },
    };
  } catch (error) {
    operationError = error;
  }

  const cleanupDeadline = Date.now() + EXPORT_CLEANUP_ALLOWANCE_MS;
  const cleanupErrors: unknown[] = [];
  if (captureScriptIdentifier) {
    try {
      await runObuCdp(
        sessionId,
        options.tabId,
        "Page.removeScriptToEvaluateOnNewDocument",
        { identifier: captureScriptIdentifier },
        cleanupDeadline,
        true,
      );
      captureScriptIdentifier = undefined;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (rawCapturePending) {
    try {
      await cleanupCaptureWithEvaluator(
        <T>(expression: string, timeoutLabel?: string) =>
          evaluateObuByValue<T>(
            sessionId,
            options.tabId,
            expression,
            cleanupDeadline,
            timeoutLabel,
            true,
          ),
        targetApiUrl,
      );
      rawCapturePending = false;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const errors = operationError ? [operationError, ...cleanupErrors] : cleanupErrors;
  if (errors.length > 1) {
    throw new AggregateError(errors, "OBU ChatGPT export and capture cleanup failed.");
  }
  if (errors.length === 1) throw errors[0];
  if (!completedResult) throw new Error("OBU ChatGPT export did not produce a result.");
  return completedResult;
}
