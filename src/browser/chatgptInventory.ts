import type { ChromeClient } from "./types.js";
import {
  closeTab,
  connectToRemoteChromeTarget,
  type RemoteChromeConnection,
} from "./chromeLifecycle.js";
import {
  browserIdFromWebSocketEndpoint,
  resolveRemoteChromeBrowserIdentity,
} from "./profileState.js";
import { delay } from "./utils.js";
import {
  MAX_CHATGPT_ACCOUNT_ID_LENGTH,
  MAX_CHATGPT_ACCOUNT_EMAIL_LENGTH,
  MAX_CHATGPT_JWT_SEGMENT_LENGTH,
  normalizeChatGptAccountDigest,
  normalizeChatGptAccountEmail,
} from "./chatgptAccount.js";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_CONVERSATIONS_URL = `${CHATGPT_ORIGIN}/backend-api/conversations`;
const CHATGPT_SESSION_URL = `${CHATGPT_ORIGIN}/api/auth/session`;
const INVENTORY_RETRY_DELAYS_MS = [15_000, 45_000, 120_000, 240_000] as const;
const INVENTORY_DEFAULT_TIMEOUT_MS =
  30_000 + INVENTORY_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0);
const INVENTORY_CLEANUP_STEP_TIMEOUT_MS = 2_000;
async function runBeforeInventoryDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
  action: string,
  disposeLateResult?: (result: T) => Promise<void> | void,
): Promise<T> {
  const remaining = deadline - Date.now();
  const timeoutMessage = `Timed out while ${action}.`;
  if (remaining <= 0) throw new Error(timeoutMessage);
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const operationResult = Promise.resolve().then(operation);
  if (disposeLateResult) {
    void operationResult
      .then((result) => {
        if (!timedOut) return;
        return Promise.resolve(disposeLateResult(result)).catch(() => undefined);
      })
      .catch(() => undefined);
  }
  try {
    return await Promise.race([
      operationResult,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(timeoutMessage));
        }, remaining);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function remainingInventoryOperationMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function runInventoryCleanup<T>(operation: () => Promise<T>, action: string): Promise<T> {
  return await runBeforeInventoryDeadline(
    operation,
    Date.now() + INVENTORY_CLEANUP_STEP_TIMEOUT_MS,
    action,
  );
}

async function disposeLateInventoryTarget(
  connection: RemoteChromeConnection,
  host: string,
  port: number,
): Promise<void> {
  await runInventoryCleanup(
    () => connection.close(),
    "closing a late ChatGPT inventory connection",
  ).catch(() => undefined);
  if (connection.targetId) {
    await runInventoryCleanup(
      () => closeTab(port, connection.targetId!, () => {}, host),
      "closing a late disposable ChatGPT inventory target",
    ).catch(() => undefined);
  }
}

export interface ChatGptInventoryOptions {
  host: string;
  port: number;
  browserId: string;
  browserWSEndpoint: string;
  expectedEmail: string;
  timeoutMs?: number;
  pageSize?: number;
}

export interface ChatGptInventoryItem {
  conversationId: string;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean;
  url: string;
}

export interface ChatGptInventoryResult {
  accountDigest: string;
  items: ChatGptInventoryItem[];
}

interface ConversationListPage {
  items: ChatGptInventoryItem[];
  total: number;
  limit: number;
  offset: number;
}

interface InventoryPageEnvelope {
  ok?: boolean;
  status?: number;
  reason?: string;
  retryAfterMs?: number;
  url?: string;
  redirected?: boolean;
  body?: unknown;
}

interface InventoryIdentityEnvelope extends InventoryPageEnvelope {
  accountDigest?: string;
  email?: string;
}

interface InventoryIdentity {
  accountDigest: string;
  email: string;
}

type FetchPage = (offset: number) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(
      `Unexpected ChatGPT conversation list schema: ${field} must be a non-negative integer.`,
    );
  }
  return Number(value);
}

function normalizeTimestamp(value: unknown, field: string): string | null {
  if (value == null) return null;
  let milliseconds: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    milliseconds = Number.isFinite(numeric)
      ? Math.abs(numeric) < 1_000_000_000_000
        ? numeric * 1_000
        : numeric
      : Date.parse(value);
  } else {
    throw new Error(`Unexpected ChatGPT conversation list schema: ${field} is invalid.`);
  }
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Unexpected ChatGPT conversation list schema: ${field} is invalid.`);
  }
  return new Date(milliseconds).toISOString();
}

function buildChatGptInventoryPageUrl(archived: boolean, offset: number, limit: number): string {
  const url = new URL(CHATGPT_CONVERSATIONS_URL);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("order", "updated");
  url.searchParams.set("is_archived", String(archived));
  return url.href;
}

export function parseChatGptConversationListPage(
  value: unknown,
  archived: boolean,
): ConversationListPage {
  const page = asRecord(value);
  if (
    !page ||
    !Array.isArray(page.items) ||
    !("total" in page) ||
    !("limit" in page) ||
    !("offset" in page)
  ) {
    throw new Error(
      "Unexpected ChatGPT conversation list schema: expected {items,total,limit,offset}.",
    );
  }
  const total = parseNonNegativeInteger(page.total, "total");
  const limit = parseNonNegativeInteger(page.limit, "limit");
  const offset = parseNonNegativeInteger(page.offset, "offset");
  if (page.items.length > limit) {
    throw new Error("Unexpected ChatGPT conversation list schema: items exceed limit.");
  }
  const items = page.items.map((value, index): ChatGptInventoryItem => {
    const item = asRecord(value);
    const conversationId = item?.id ?? item?.conversation_id;
    if (!item || typeof conversationId !== "string" || !conversationId.trim()) {
      throw new Error(
        `Unexpected ChatGPT conversation list schema: item ${index} has no conversation id.`,
      );
    }
    if (item.title != null && typeof item.title !== "string") {
      throw new Error(
        `Unexpected ChatGPT conversation list schema: item ${index} title is invalid.`,
      );
    }
    const id = conversationId.trim();
    return {
      conversationId: id,
      title: typeof item.title === "string" ? item.title : "",
      createdAt: normalizeTimestamp(item.create_time ?? item.created_at, `item ${index} createdAt`),
      updatedAt: normalizeTimestamp(item.update_time ?? item.updated_at, `item ${index} updatedAt`),
      archived,
      url: `https://chatgpt.com/c/${encodeURIComponent(id)}`,
    };
  });
  return { items, total, limit, offset };
}

export async function paginateChatGptConversationList(
  fetchPage: FetchPage,
  archived: boolean,
): Promise<ChatGptInventoryItem[]> {
  const items: ChatGptInventoryItem[] = [];
  let offset = 0;
  while (true) {
    const page = parseChatGptConversationListPage(await fetchPage(offset), archived);
    if (page.offset !== offset) {
      throw new Error(
        `Unexpected ChatGPT conversation list pagination: requested offset ${offset}, received ${page.offset}.`,
      );
    }
    const nextOffset = offset + page.items.length;
    if (page.total < nextOffset) {
      throw new Error(
        "Unexpected ChatGPT conversation list pagination: total precedes returned items.",
      );
    }
    if (page.items.length === 0 && nextOffset < page.total) {
      throw new Error("Unexpected ChatGPT conversation list pagination: empty page before total.");
    }
    items.push(...page.items);
    if (nextOffset >= page.total) return items;
    offset = nextOffset;
  }
}

export function buildChatGptInventoryAuthCaptureHook(): string {
  return `
(() => {
  const KEY = "__oracleChatGptInventory";
  if (window[KEY]?.version === 5) return;
  try { window[KEY]?.cleanup?.(); } catch {}
  const ORIGIN = ${JSON.stringify(CHATGPT_ORIGIN)};
  const CONVERSATIONS_PATH = "/backend-api/conversations";
  const SESSION_URL = ${JSON.stringify(CHATGPT_SESSION_URL)};
  const MAX_ACCOUNT_ID_LENGTH = ${MAX_CHATGPT_ACCOUNT_ID_LENGTH};
  const MAX_EMAIL_LENGTH = ${MAX_CHATGPT_ACCOUNT_EMAIL_LENGTH};
  const MAX_JWT_SEGMENT_LENGTH = ${MAX_CHATGPT_JWT_SEGMENT_LENGTH};
  const EMAIL_PATTERN = /^[^@\\s]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  const normalizeEmail = (value) => {
    const email = typeof value === "string" ? value.trim().toLowerCase() : "";
    return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email) ? email : "";
  };
  const normalizeUserId = (value) => {
    const userId = typeof value === "string" ? value.trim() : "";
    return userId.length > 0 && userId.length <= MAX_ACCOUNT_ID_LENGTH ? userId : "";
  };
  const originalFetch = window.fetch;
  let capturedHeaders = null;
  let retainedHeaders = null;
  const copyCapturedHeaders = () => {
    if (!(capturedHeaders instanceof Headers)) return null;
    const headers = new Headers(capturedHeaders);
    headers.set("accept", "application/json");
    headers.delete("content-length");
    headers.delete("x-openai-target-path");
    headers.delete("x-openai-target-route");
    return headers.get("authorization")?.trim() ? headers : null;
  };
  const identityFromAuthorization = async (headers) => {
    try {
      const authorization = headers.get("authorization")?.trim() ?? "";
      const match = /^Bearer\\s+([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)$/i.exec(authorization);
      if (!match || match.slice(1).some((segment) => segment.length > MAX_JWT_SEGMENT_LENGTH)) return null;
      const encoded = match[2].replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
      const auth = payload?.["https://api.openai.com/auth"];
      const profile = payload?.["https://api.openai.com/profile"];
      const userIds = [auth?.chatgpt_user_id, auth?.user_id]
        .map(normalizeUserId)
        .filter(Boolean);
      const email = normalizeEmail(profile?.email);
      if (!email || userIds.length === 0 || userIds.some((value) => value !== userIds[0])) {
        return null;
      }
      const bytes = new Uint8Array(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(userIds[0]),
      ));
      return {
        accountDigest: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        email,
      };
    } catch {
      return null;
    }
  };
  const requestJson = async (rawUrl, headers, credentials, deadline) => {
    let controller = null;
    let timeout = null;
    try {
      const url = new URL(rawUrl);
      if (url.origin !== ORIGIN) return { ok: false, reason: "origin" };
      const remaining = deadline - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        return { ok: false, reason: "timeout" };
      }
      controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), remaining);
      const response = await originalFetch.call(window, url.href, {
        method: "GET",
        credentials,
        cache: "no-store",
        redirect: "error",
        headers,
        signal: controller.signal,
      });
      const details = {
        status: response.status,
        url: response.url,
        redirected: response.redirected,
      };
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        let retryAfterMs = null;
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const date = Date.parse(retryAfter);
          retryAfterMs = Number.isFinite(seconds) && seconds >= 0
            ? Math.ceil(seconds * 1000)
            : Number.isFinite(date)
              ? Math.max(0, date - Date.now())
              : null;
        }
        return { ok: false, reason: "http", retryAfterMs, ...details };
      }
      try {
        return { ok: true, body: await response.json(), ...details };
      } catch {
        return {
          ok: false,
          reason: controller.signal.aborted ? "timeout" : "json",
          ...details,
        };
      }
    } catch {
      return { ok: false, reason: controller?.signal.aborted ? "timeout" : "request" };
    } finally {
      clearTimeout(timeout);
    }
  };
  const readIdentity = async (headers, credentials, deadline) => {
    const response = await requestJson(SESSION_URL, headers, credentials, deadline);
    if (!response.ok) return response;
    const identityFailure = () => ({
      ok: false,
      reason: "identity",
      status: response.status,
      url: response.url,
      redirected: response.redirected,
    });
    try {
      const userId = normalizeUserId(response.body?.user?.id);
      const email = normalizeEmail(response.body?.user?.email);
      if (!userId || !email || !globalThis.crypto?.subtle) return identityFailure();
      const bytes = new Uint8Array(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(userId),
      ));
      return {
        ok: true,
        status: response.status,
        url: response.url,
        redirected: response.redirected,
        accountDigest: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        email,
      };
    } catch {
      return identityFailure();
    }
  };
  const inventory = {
    version: 5,
    get ready() { return capturedHeaders instanceof Headers; },
    async readCookieIdentity(deadline) {
      return readIdentity(new Headers({ accept: "application/json" }), "include", deadline);
    },
    async bindRetainedAuthorization(deadline) {
      const headers = copyCapturedHeaders();
      if (!headers) return { ok: false, reason: "auth" };
      const cookieIdentity = await readIdentity(
        new Headers({ accept: "application/json" }),
        "include",
        deadline,
      );
      if (!cookieIdentity.ok) return cookieIdentity;
      const bearerIdentity = await identityFromAuthorization(headers);
      if (
        !bearerIdentity ||
        bearerIdentity.accountDigest !== cookieIdentity.accountDigest ||
        bearerIdentity.email !== cookieIdentity.email
      ) {
        return {
          ok: false,
          reason: "identity",
          status: cookieIdentity.status,
          url: cookieIdentity.url,
          redirected: cookieIdentity.redirected,
        };
      }
      retainedHeaders = new Headers(headers);
      return cookieIdentity;
    },
    async fetchPage(rawUrl, deadline) {
      try {
        const url = new URL(rawUrl);
        if (url.origin !== ORIGIN || url.pathname !== CONVERSATIONS_PATH) {
          return { ok: false, reason: "origin" };
        }
        if (!(retainedHeaders instanceof Headers)) return { ok: false, reason: "auth" };
        return await requestJson(url.href, new Headers(retainedHeaders), "include", deadline);
      } catch {
        return { ok: false, reason: "request" };
      }
    },
    cleanup() {
      capturedHeaders = null;
      retainedHeaders = null;
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      if (window[KEY] === inventory) delete window[KEY];
      return window.fetch === originalFetch && window[KEY] !== inventory;
    },
  };
  const wrappedFetch = async function(input, init) {
    try {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url, location.href);
      if (
        !retainedHeaders &&
        request.method.toUpperCase() === "GET" &&
        url.origin === ORIGIN &&
        url.pathname === CONVERSATIONS_PATH &&
        request.headers.has("authorization")
      ) {
        capturedHeaders = new Headers(request.headers);
      }
    } catch {}
    return originalFetch.call(this, input, init);
  };
  window[KEY] = inventory;
  window.fetch = wrappedFetch;
})();
`.trim();
}

export function buildChatGptInventoryCleanupExpression(): string {
  return `(() => {
    const inventory = window.__oracleChatGptInventory;
    if (!inventory || typeof inventory.cleanup !== "function") return true;
    try {
      return inventory.cleanup() === true && !window.__oracleChatGptInventory;
    } catch {
      return false;
    }
  })()`;
}

export function buildChatGptInventoryPageExpression(
  archived: boolean,
  offset: number,
  limit: number,
  budgetMs = 30_000,
): string {
  const pageBudgetMs = Math.max(0, Math.floor(budgetMs));
  return `(() => (async () => {
    try {
      const budgetMs = ${JSON.stringify(pageBudgetMs)};
      const deadline = Date.now() + budgetMs;
      const url = new URL(${JSON.stringify(CHATGPT_CONVERSATIONS_URL)});
      url.searchParams.set('offset', ${JSON.stringify(String(offset))});
      url.searchParams.set('limit', ${JSON.stringify(String(limit))});
      url.searchParams.set('order', 'updated');
      url.searchParams.set('is_archived', ${JSON.stringify(String(archived))});
      const inventory = window.__oracleChatGptInventory;
      if (!inventory || typeof inventory.fetchPage !== 'function') {
        return { ok: false, reason: 'auth' };
      }
      return await inventory.fetchPage(url.href, deadline);
    } catch {
      return { ok: false, reason: 'request' };
    }
  })())()`;
}

function assertExactInventoryResponse(
  envelope: InventoryPageEnvelope | null,
  expectedUrl: string,
  action: string,
): void {
  if (envelope?.redirected !== false) {
    throw new Error(`${action} redirected or did not return redirect metadata.`);
  }
  if (envelope.url !== expectedUrl) {
    throw new Error(`${action} response URL did not match its exact request.`);
  }
}

async function evaluateInventoryIdentity(
  Runtime: ChromeClient["Runtime"],
  method: "readCookieIdentity" | "bindRetainedAuthorization",
  expectedEmail: string,
  action: string,
  deadline: number,
): Promise<InventoryIdentity> {
  const outcome = await runBeforeInventoryDeadline(
    () => {
      const budgetMs = remainingInventoryOperationMs(deadline);
      return Runtime.evaluate({
        expression: `(() => {
      const budgetMs = ${JSON.stringify(budgetMs)};
      const deadline = Date.now() + budgetMs;
      const inventory = window.__oracleChatGptInventory;
      return inventory && typeof inventory.${method} === "function"
        ? inventory.${method}(deadline)
        : { ok: false, reason: "auth" };
    })()`,
        awaitPromise: true,
        returnByValue: true,
      });
    },
    deadline,
    action,
  );
  if (outcome.exceptionDetails) {
    throw new Error(`${action} request failed in page context.`);
  }
  const envelope = asRecord(outcome.result?.value) as InventoryIdentityEnvelope | null;
  assertExactInventoryResponse(envelope, CHATGPT_SESSION_URL, action);
  if (envelope?.ok !== true) {
    if (envelope?.reason === "timeout") {
      throw new Error(`Timed out while ${action}.`);
    }
    if (envelope?.reason === "identity") {
      throw new Error(`${action} is unavailable.`);
    }
    const suffix = typeof envelope?.status === "number" ? ` (HTTP ${envelope.status})` : "";
    throw new Error(`${action} request failed${suffix}.`);
  }
  const accountDigest = normalizeChatGptAccountDigest(envelope?.accountDigest);
  const email = normalizeChatGptAccountEmail(envelope?.email);
  if (!accountDigest || !email) {
    throw new Error(`${action} is unavailable.`);
  }
  if (email !== expectedEmail) {
    throw new Error(`Authenticated ChatGPT email changed before ${action}.`);
  }
  return { accountDigest, email };
}

async function evaluateInventoryPage(
  Runtime: ChromeClient["Runtime"],
  archived: boolean,
  offset: number,
  limit: number,
  deadline: number,
): Promise<unknown> {
  const action = "ChatGPT conversation inventory request";
  const expectedUrl = buildChatGptInventoryPageUrl(archived, offset, limit);
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await runBeforeInventoryDeadline(
      () =>
        Runtime.evaluate({
          expression: buildChatGptInventoryPageExpression(
            archived,
            offset,
            limit,
            remainingInventoryOperationMs(deadline),
          ),
          awaitPromise: true,
          returnByValue: true,
        }),
      deadline,
      action,
    );
    if (outcome.exceptionDetails) {
      throw new Error(`${action} failed in page context.`);
    }
    const envelope = asRecord(outcome.result?.value) as InventoryPageEnvelope | null;
    assertExactInventoryResponse(envelope, expectedUrl, action);
    if (envelope?.ok === true) return envelope.body;
    if (envelope?.reason === "timeout") {
      throw new Error(`Timed out while ${action}.`);
    }

    const status = typeof envelope?.status === "number" ? envelope.status : undefined;
    const retryable = status === 429 || (status !== undefined && status >= 500 && status <= 599);
    const fallbackDelay = INVENTORY_RETRY_DELAYS_MS[attempt];
    if (!retryable || fallbackDelay === undefined) {
      const suffix = status === undefined ? "" : ` (HTTP ${status})`;
      throw new Error(`${action} failed${suffix}.`);
    }
    const requestedDelay =
      typeof envelope?.retryAfterMs === "number" &&
      Number.isFinite(envelope.retryAfterMs) &&
      envelope.retryAfterMs >= 0
        ? envelope.retryAfterMs
        : fallbackDelay;
    const remaining = deadline - Date.now();
    if (requestedDelay >= remaining) {
      throw new Error(`Timed out while retrying ${action}.`);
    }
    await runBeforeInventoryDeadline(() => delay(requestedDelay), deadline, `retrying ${action}`);
  }
}

async function waitForChatGptDocument(
  Runtime: ChromeClient["Runtime"],
  deadline: number,
): Promise<void> {
  while (Date.now() < deadline) {
    const outcome = await runBeforeInventoryDeadline(
      () =>
        Runtime.evaluate({
          expression: `({ href: location.href, readyState: document.readyState })`,
          returnByValue: true,
        }),
      deadline,
      "waiting for the disposable ChatGPT inventory page",
    );
    const state = asRecord(outcome.result?.value);
    if (
      typeof state?.href === "string" &&
      state.href.startsWith("https://chatgpt.com/") &&
      (state.readyState === "interactive" || state.readyState === "complete")
    ) {
      return;
    }
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error("Timed out waiting for the disposable ChatGPT inventory page.");
}

async function waitForAuthenticatedInventoryRequest(
  Runtime: ChromeClient["Runtime"],
  deadline: number,
): Promise<void> {
  while (Date.now() < deadline) {
    const outcome = await runBeforeInventoryDeadline(
      () =>
        Runtime.evaluate({
          expression: "Boolean(window.__oracleChatGptInventory?.ready)",
          returnByValue: true,
        }),
      deadline,
      "waiting for an authenticated ChatGPT conversation request",
    );
    if (outcome.result?.value === true) return;
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error("Timed out waiting for an authenticated ChatGPT conversation request.");
}

export async function captureChatGptConversationInventory(
  options: ChatGptInventoryOptions,
): Promise<ChatGptInventoryResult> {
  const browserId = options.browserId.trim();
  const browserWSEndpoint = options.browserWSEndpoint.trim();
  const expectedEmail = normalizeChatGptAccountEmail(options.expectedEmail);
  if (!browserId || !browserWSEndpoint || !expectedEmail) {
    throw new Error(
      "ChatGPT inventory requires complete browser identity and a valid expected email.",
    );
  }
  if (browserIdFromWebSocketEndpoint(browserWSEndpoint) !== browserId) {
    throw new Error("ChatGPT inventory browser id does not match its WebSocket.");
  }
  const timeoutMs = options.timeoutMs ?? INVENTORY_DEFAULT_TIMEOUT_MS;
  const pageSize = options.pageSize ?? 100;
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error("ChatGPT inventory page size must be a positive integer.");
  }
  const deadline = Date.now() + timeoutMs;
  let connection: RemoteChromeConnection | undefined;
  let cleanupRequired = false;
  let captureScriptIdentifier: string | undefined;
  let result: ChatGptInventoryResult | undefined;
  let operationError: unknown;
  try {
    const liveIdentity = await runBeforeInventoryDeadline(
      () =>
        resolveRemoteChromeBrowserIdentity({
          host: options.host,
          port: options.port,
        }),
      deadline,
      "resolving the remote Chrome browser identity for ChatGPT inventory",
    );
    if (liveIdentity.browserId !== browserId) {
      throw new Error("Remote Chrome browser identity changed before ChatGPT inventory.");
    }
    connection = await runBeforeInventoryDeadline(
      () =>
        connectToRemoteChromeTarget(options.host, options.port, () => {}, {
          targetUrl: "https://chatgpt.com/",
          browserWSEndpoint: liveIdentity.browserWSEndpoint,
          closeTargetOnDispose: false,
          approvalWaitMs: remainingInventoryOperationMs(deadline),
        }),
      deadline,
      "opening the disposable ChatGPT inventory target",
      (lateConnection) => disposeLateInventoryTarget(lateConnection, options.host, options.port),
    );
    const { Page, Runtime } = connection.client;
    const authCaptureHook = buildChatGptInventoryAuthCaptureHook();
    await runBeforeInventoryDeadline(
      () => Page.enable(),
      deadline,
      "preparing the ChatGPT inventory target",
    );
    cleanupRequired = true;
    await runBeforeInventoryDeadline(
      () =>
        Runtime.evaluate({
          expression: authCaptureHook,
          awaitPromise: false,
          returnByValue: true,
        }),
      deadline,
      "installing ChatGPT inventory authorization capture",
    );
    const registration = await runBeforeInventoryDeadline(
      () => Page.addScriptToEvaluateOnNewDocument({ source: authCaptureHook }),
      deadline,
      "registering ChatGPT inventory authorization capture",
    );
    captureScriptIdentifier = registration.identifier;
    await runBeforeInventoryDeadline(
      () => Page.navigate({ url: "https://chatgpt.com/" }),
      deadline,
      "navigating the ChatGPT inventory target",
    );
    await waitForChatGptDocument(Runtime, deadline);
    await waitForAuthenticatedInventoryRequest(Runtime, deadline);
    const cookieIdentity = await evaluateInventoryIdentity(
      Runtime,
      "readCookieIdentity",
      expectedEmail,
      "ChatGPT inventory cookie identity",
      deadline,
    );
    const bearerIdentity = await evaluateInventoryIdentity(
      Runtime,
      "bindRetainedAuthorization",
      expectedEmail,
      "ChatGPT inventory bearer identity",
      deadline,
    );
    if (
      bearerIdentity.email !== cookieIdentity.email ||
      bearerIdentity.accountDigest !== cookieIdentity.accountDigest
    ) {
      throw new Error(
        "Retained ChatGPT authorization does not match the authenticated ChatGPT account.",
      );
    }
    const active = await paginateChatGptConversationList(
      (offset) => evaluateInventoryPage(Runtime, false, offset, pageSize, deadline),
      false,
    );
    const archived = await paginateChatGptConversationList(
      (offset) => evaluateInventoryPage(Runtime, true, offset, pageSize, deadline),
      true,
    );
    const completionIdentity = await evaluateInventoryIdentity(
      Runtime,
      "readCookieIdentity",
      expectedEmail,
      "ChatGPT inventory completion cookie identity",
      deadline,
    );
    if (
      completionIdentity.email !== cookieIdentity.email ||
      completionIdentity.accountDigest !== cookieIdentity.accountDigest
    ) {
      throw new Error("Remote Chrome account identity changed during ChatGPT inventory.");
    }
    result = { accountDigest: cookieIdentity.accountDigest, items: [...active, ...archived] };
  } catch (error) {
    operationError = error;
  }
  const cleanupErrors: unknown[] = [];
  if (connection) {
    const { Page, Runtime } = connection.client;
    if (cleanupRequired) {
      try {
        const cleanup = await runInventoryCleanup(
          () =>
            Runtime.evaluate({
              expression: buildChatGptInventoryCleanupExpression(),
              awaitPromise: false,
              returnByValue: true,
            }),
          "cleaning up ChatGPT inventory authorization capture",
        );
        if (cleanup.exceptionDetails || cleanup.result?.value !== true) {
          throw new Error("ChatGPT inventory authorization cleanup was not confirmed.");
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (captureScriptIdentifier) {
      try {
        await runInventoryCleanup(
          () => Page.removeScriptToEvaluateOnNewDocument({ identifier: captureScriptIdentifier }),
          "removing ChatGPT inventory authorization capture",
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await runInventoryCleanup(
        () => connection.close(),
        "closing the ChatGPT inventory connection",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      const closed = connection.targetId
        ? await runInventoryCleanup(
            () => closeTab(options.port, connection.targetId!, () => {}, options.host),
            "closing the disposable ChatGPT inventory target",
          )
        : false;
      if (!closed) {
        throw new Error("ChatGPT inventory target cleanup was not confirmed.");
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const closeError =
    cleanupErrors.length > 1
      ? new AggregateError(
          cleanupErrors,
          "ChatGPT inventory connection and disposable-target cleanup both failed.",
        )
      : cleanupErrors[0];
  if (operationError && closeError) {
    throw new AggregateError(
      [operationError, closeError],
      "ChatGPT inventory and disposable-target cleanup both failed.",
    );
  }
  if (operationError) throw operationError;
  if (closeError) throw closeError;
  if (!result) throw new Error("ChatGPT inventory did not produce a result.");
  return result;
}
