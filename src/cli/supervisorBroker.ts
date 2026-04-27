import { randomUUID } from "node:crypto";
import process from "node:process";
import readline from "node:readline";
import type { LaunchedChrome } from "chrome-launcher";
import {
  attachSupervisorThread,
  listSupervisorBrowserEntries,
  newSupervisorThread,
  readAttachedSupervisorThreadHistory,
  readCurrentSupervisorThread,
  type SupervisorThreadHistoryWindow,
  supervisorThreadMatchesProjectScope,
  type SupervisorThreadHistoryEntry,
  type SupervisorThreadInfo,
  type SupervisorBrowserEntry,
} from "../browser/supervisorThreads.js";
import { normalizeSupervisorThread } from "../browser/supervisorThreadNormalize.js";
import {
  hideChromeWindow,
  startChromeFocusGuard,
  finalizeChromeFocusProtection,
} from "../browser/chromeLifecycle.js";
import { sessionStore, type SessionMetadata } from "../sessionStore.js";
import {
  connectSupervisorRuntime,
  releaseBrowserbaseSupervisorRuntimeSessions,
  resolveSupervisorRuntimeContext,
  type SupervisorRuntimeBrowserProvider,
} from "./supervisorBrokerRuntime.js";
import {
  runSupervisorPromptOperation,
  withSupervisorRuntimeAttachLease,
  type SupervisorPromptRequest,
} from "./supervisorBrokerPrompt.js";
import type { SupervisorThreadBindingMetadata } from "../sessionStore.js";

export type SupervisorBrokerOperation =
  | "run_prompt"
  | "list_threads"
  | "new_thread"
  | "attach_thread"
  | "thread_history";

export interface SupervisorBrokerRequest extends SupervisorPromptRequest {
  operation?: SupervisorBrokerOperation;
  action?: SupervisorBrokerOperation;
  conversationId?: string;
  threadUrl?: string;
  historyLimit?: number;
  browseScope?: "root" | "project";
  projectUrl?: string;
  shutdown?: boolean;
}

export type SupervisorBrokerResponse =
  | { ok: true; sessionId: string; output: string }
  | { ok: true; threads: (SupervisorThreadInfo | SupervisorBrowserEntry)[] }
  | {
      ok: true;
      thread: SupervisorThreadInfo;
      sessionId: string;
      history?: SupervisorThreadHistoryEntry[];
      historyWindow?: SupervisorThreadHistoryWindow;
    }
  | { ok: false; error: string; sessionId?: string };

export interface SupervisorBrokerDeps {
  runPrompt?: (
    request: SupervisorPromptRequest,
  ) => Promise<
    | { ok: true; sessionId: string; output: string }
    | { ok: false; error: string; sessionId?: string }
  >;
  listThreads?: (
    request: SupervisorBrokerRequest,
  ) => Promise<{ ok: true; threads: (SupervisorThreadInfo | SupervisorBrowserEntry)[] }>;
  newThread?: (
    request: SupervisorBrokerRequest,
  ) => Promise<{ ok: true; thread: SupervisorThreadInfo; sessionId: string }>;
  attachThread?: (request: SupervisorBrokerRequest) => Promise<{
    ok: true;
    thread: SupervisorThreadInfo;
    sessionId: string;
    history?: SupervisorThreadHistoryEntry[];
    historyWindow?: SupervisorThreadHistoryWindow;
  }>;
  threadHistory?: (request: SupervisorBrokerRequest) => Promise<{
    ok: true;
    thread: SupervisorThreadInfo;
    sessionId: string;
    history: SupervisorThreadHistoryEntry[];
    historyWindow?: SupervisorThreadHistoryWindow;
  }>;
}

const supervisorChromeLogger = Object.assign((_message?: string) => {}, { verbose: false });
const SUPERVISOR_THREAD_PROMPT_PREFIX = "Supervisor thread:";
const SUPERVISOR_RUNTIME_BOOTSTRAP_MODEL = "gpt-5.5";
const SUPERVISOR_RUNTIME_BOOTSTRAP_MODEL_LABEL = "Thinking 5.5";
const SUPERVISOR_RUNTIME_BOOTSTRAP_MODEL_STRATEGY = "select";
const SUPERVISOR_CONVERSATION_RESPONSE_TIMEOUT_MS = 12_000;
const SUPERVISOR_HISTORY_LIMIT_DEFAULT = 100;
const SUPERVISOR_HISTORY_LIMIT_MAX = 200;
const SUPERVISOR_CHATGPT_URL_ENV = "ORACLE_SUPERVISOR_CHATGPT_URL";
const CHATGPT_ROOT_URL = "https://chatgpt.com/";

async function writeSupervisorBrokerResponseLine(response: unknown): Promise<void> {
  const line = `${JSON.stringify(response)}\n`;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(line, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

interface ChromeFocusDeps {
  hideChromeWindow: typeof hideChromeWindow;
  startChromeFocusGuard: typeof startChromeFocusGuard;
  finalizeChromeFocusProtection: typeof finalizeChromeFocusProtection;
}

interface SupervisorRuntimeDeps {
  resolveSupervisorRuntimeContext: typeof resolveSupervisorRuntimeContext;
  connectSupervisorRuntime: typeof connectSupervisorRuntime;
  withSupervisorRuntimeAttachLease: typeof withSupervisorRuntimeAttachLease;
}

interface SupervisorRuntimeUseOptions {
  allowChatgptShellRecovery?: boolean;
  dedicatedHiddenTargetUrl?: string;
  browserProvider?: SupervisorRuntimeBrowserProvider;
}

type SupervisorRuntimeClient = Awaited<ReturnType<typeof connectSupervisorRuntime>>["client"];

const chromeFocusDeps: ChromeFocusDeps = {
  hideChromeWindow,
  startChromeFocusGuard,
  finalizeChromeFocusProtection,
};

const supervisorRuntimeDeps: SupervisorRuntimeDeps = {
  resolveSupervisorRuntimeContext,
  connectSupervisorRuntime,
  withSupervisorRuntimeAttachLease,
};

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function supervisorRuntimeBrowserProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SupervisorRuntimeBrowserProvider | undefined {
  const browserbaseEnabled = parseBooleanEnv(env.ORACLE_BROWSERBASE_ENABLED);
  if (browserbaseEnabled === true) {
    return "browserbase";
  }
  if (browserbaseEnabled === false) {
    return "local-hidden";
  }
  return undefined;
}

function resolveSupervisorRuntimeUseOptions(
  options: SupervisorRuntimeUseOptions,
): SupervisorRuntimeUseOptions {
  if (options.browserProvider) {
    return options;
  }
  const browserProvider = supervisorRuntimeBrowserProviderFromEnv();
  return browserProvider ? { ...options, browserProvider } : options;
}

async function releaseBrowserbaseSupervisorRuntimesForBrokerShutdown(
  releaseSessions: typeof releaseBrowserbaseSupervisorRuntimeSessions = releaseBrowserbaseSupervisorRuntimeSessions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await releaseSessions({ env, log: supervisorChromeLogger });
}

function supervisorBrokerSignalExitCode(signal: NodeJS.Signals): number {
  switch (signal) {
    case "SIGHUP":
      return 129;
    case "SIGINT":
      return 130;
    case "SIGQUIT":
      return 131;
    case "SIGTERM":
      return 143;
    default:
      return 1;
  }
}

function installSupervisorBrokerBrowserbaseReleaseCleanup({
  releaseBrowserbaseSessions = releaseBrowserbaseSupervisorRuntimesForBrokerShutdown,
  processLike = process,
  exitFn = (code: number) => process.exit(code),
}: {
  releaseBrowserbaseSessions?: () => Promise<void>;
  processLike?: Pick<NodeJS.Process, "on" | "off">;
  exitFn?: (code: number) => void;
} = {}): {
  dispose: () => void;
  release: () => Promise<void>;
  waitForCleanup: () => Promise<void>;
} {
  let active = true;
  let cleanup: Promise<void> | null = null;
  const listeners = new Map<NodeJS.Signals, () => void>();

  const dispose = () => {
    if (!active) {
      return;
    }
    active = false;
    for (const [signal, handler] of listeners) {
      processLike.off(signal, handler);
    }
    listeners.clear();
  };

  const runCleanup = (signal?: NodeJS.Signals): Promise<void> => {
    if (cleanup) {
      return cleanup;
    }
    dispose();
    cleanup = (async () => {
      try {
        await releaseBrowserbaseSessions();
      } finally {
        if (signal) {
          exitFn(supervisorBrokerSignalExitCode(signal));
        }
      }
    })();
    return cleanup;
  };

  for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const) {
    const handler = () => {
      void runCleanup(signal);
    };
    listeners.set(signal, handler);
    processLike.on(signal, handler);
  }

  return {
    dispose,
    release: async () => {
      await runCleanup();
    },
    waitForCleanup: async () => {
      await cleanup;
    },
  };
}

function normalizeComparableUrl(url?: string | null): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function extractProjectIdFromUrl(projectUrl?: string): string | undefined {
  const normalized = normalizeComparableUrl(projectUrl);
  if (!normalized) {
    return undefined;
  }
  try {
    const parsed = new URL(normalized);
    return parsed.pathname.match(/^\/g\/([^/]+)/i)?.[1];
  } catch {
    return normalized.match(/\/g\/([^/]+)/i)?.[1];
  }
}

function isProjectUrl(url?: string | null): boolean {
  return Boolean(extractProjectIdFromUrl(url ?? undefined));
}

function normalizeProjectIdForComparison(projectId?: string | null): string | undefined {
  const trimmed = projectId?.trim().toLowerCase();
  return trimmed ? trimmed.replace(/-oracle$/i, "") : undefined;
}

function projectIdsEquivalent(left?: string | null, right?: string | null): boolean {
  const normalizedLeft = normalizeProjectIdForComparison(left);
  const normalizedRight = normalizeProjectIdForComparison(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function readHeaderValue(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function removeSupervisorRuntimeListener(
  client: SupervisorRuntimeClient,
  eventName: string,
  listener: (params: object, sessionId?: string) => void,
): void {
  const emitter = client as unknown as {
    off?: (event: string, callback: (params: object, sessionId?: string) => void) => void;
    removeListener?: (
      event: string,
      callback: (params: object, sessionId?: string) => void,
    ) => void;
  };
  if (typeof emitter.off === "function") {
    emitter.off(eventName, listener);
    return;
  }
  if (typeof emitter.removeListener === "function") {
    emitter.removeListener(eventName, listener);
  }
}

function collectConversationTextSegments(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectConversationTextSegments(entry));
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string" && record.text.trim().length > 0) {
    return [record.text];
  }
  if (typeof record.content === "string" && record.content.trim().length > 0) {
    return [record.content];
  }
  return [];
}

function normalizeConversationHistoryText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeConversationResponseHistory(
  payload: unknown,
  options: { conversationId: string; limit?: number },
): {
  history: SupervisorThreadHistoryEntry[];
  historyWindow: SupervisorThreadHistoryWindow;
} {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const responseConversationId =
    (typeof record.conversation_id === "string" && record.conversation_id.trim()) ||
    (typeof record.id === "string" && record.id.trim()) ||
    undefined;
  if (responseConversationId && responseConversationId !== options.conversationId) {
    throw new Error(
      `Oracle conversation response returned ${responseConversationId} while ${options.conversationId} was requested.`,
    );
  }
  const currentNodeId =
    typeof record.current_node === "string" && record.current_node.trim().length > 0
      ? record.current_node.trim()
      : undefined;
  const mapping =
    record.mapping && typeof record.mapping === "object"
      ? (record.mapping as Record<string, unknown>)
      : undefined;
  if (!currentNodeId || !mapping) {
    throw new Error("Oracle conversation response did not include a current mapping path.");
  }

  const orderedPath: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = currentNodeId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = mapping[cursor];
    if (!node || typeof node !== "object") {
      break;
    }
    const recordNode = node as Record<string, unknown>;
    orderedPath.push(recordNode);
    cursor =
      typeof recordNode.parent === "string" && recordNode.parent.trim().length > 0
        ? recordNode.parent.trim()
        : undefined;
  }
  orderedPath.reverse();

  const history: SupervisorThreadHistoryEntry[] = [];
  for (const node of orderedPath) {
    const message =
      node.message && typeof node.message === "object"
        ? (node.message as Record<string, unknown>)
        : undefined;
    if (!message) {
      continue;
    }
    const author =
      message.author && typeof message.author === "object"
        ? (message.author as Record<string, unknown>)
        : undefined;
    const role = author?.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const metadata =
      message.metadata && typeof message.metadata === "object"
        ? (message.metadata as Record<string, unknown>)
        : undefined;
    if (metadata?.is_visually_hidden_from_conversation === true) {
      continue;
    }
    const content =
      message.content && typeof message.content === "object"
        ? (message.content as Record<string, unknown>)
        : undefined;
    const text = normalizeConversationHistoryText(
      collectConversationTextSegments(content?.parts).join("\n\n"),
    );
    if (!text) {
      continue;
    }
    const last = history.at(-1);
    if (last && last.role === role && last.text === text) {
      continue;
    }
    history.push({ role, text });
  }

  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 100)), 200);
  const limitedHistory = history.slice(-limit);
  return {
    history: limitedHistory,
    historyWindow: {
      limit,
      returnedCount: limitedHistory.length,
      totalCount: history.length,
      truncated: history.length > limitedHistory.length,
    },
  };
}

async function readProjectConversationHistoryFromResponse(
  client: SupervisorRuntimeClient,
  options: {
    conversationId: string;
    threadUrl: string;
    projectUrl: string;
    limit?: number;
  },
): Promise<{
  history: SupervisorThreadHistoryEntry[];
  historyWindow: SupervisorThreadHistoryWindow;
}> {
  const { Network, Page, Runtime } = client;
  if (!Network || !Page || !Runtime) {
    throw new Error(
      "Oracle supervisor runtime is missing Network/Page domains for history recovery.",
    );
  }

  const normalizedThreadUrl = normalizeComparableUrl(options.threadUrl);
  if (!normalizedThreadUrl) {
    throw new Error("Oracle history recovery requires a concrete thread URL.");
  }
  const responseUrl = new URL(
    `/backend-api/conversation/${options.conversationId}`,
    normalizedThreadUrl,
  ).toString();
  const comparableResponseUrl = normalizeComparableUrl(responseUrl);
  const expectedProjectId = extractProjectIdFromUrl(options.projectUrl);
  let requestHeaders: Record<string, unknown> | undefined;
  const matchesResponseUrl = (value: unknown): boolean =>
    typeof value === "string" && normalizeComparableUrl(value) === comparableResponseUrl;

  const responseMatch = await new Promise<{ requestId: string; status: number }>(
    (resolve, reject) => {
      let settled = false;
      let matchedResponse: { requestId: string; status: number } | null = null;
      const finishedRequestIds = new Set<string>();
      const requestListener = (params: object) => {
        if (settled) {
          return;
        }
        const request = (params as Record<string, unknown>).request as
          | Record<string, unknown>
          | undefined;
        if (!request || !matchesResponseUrl(request.url)) {
          return;
        }
        requestHeaders =
          request.headers && typeof request.headers === "object"
            ? (request.headers as Record<string, unknown>)
            : undefined;
      };
      const loadingFinishedListener = (params: object) => {
        if (settled) {
          return;
        }
        const requestId = String((params as Record<string, unknown>).requestId);
        finishedRequestIds.add(requestId);
        tryResolveLoadedResponse(requestId);
      };
      const loadingFailedListener = (params: object) => {
        if (settled || !matchedResponse) {
          return;
        }
        const requestId = String((params as Record<string, unknown>).requestId);
        if (requestId !== matchedResponse.requestId) {
          return;
        }
        settled = true;
        cleanup();
        reject(
          new Error(
            `Oracle conversation response failed to load for ${options.conversationId}: ${String(
              (params as Record<string, unknown>).errorText ?? "unknown error",
            )}.`,
          ),
        );
      };
      const responseReceivedListener = (params: object) => {
        if (settled) {
          return;
        }
        const response = (params as Record<string, unknown>).response as
          | Record<string, unknown>
          | undefined;
        if (!response || !matchesResponseUrl(response.url)) {
          return;
        }
        matchedResponse = {
          requestId: String((params as Record<string, unknown>).requestId),
          status: Number(response.status ?? 0),
        };
        tryResolveLoadedResponse(matchedResponse.requestId);
      };
      const cleanup = () => {
        clearTimeout(timer);
        removeSupervisorRuntimeListener(client, "Network.requestWillBeSent", requestListener);
        removeSupervisorRuntimeListener(client, "Network.loadingFinished", loadingFinishedListener);
        removeSupervisorRuntimeListener(client, "Network.loadingFailed", loadingFailedListener);
        removeSupervisorRuntimeListener(
          client,
          "Network.responseReceived",
          responseReceivedListener,
        );
      };
      const timer = setTimeout(() => {
        settled = true;
        cleanup();
        reject(
          new Error(
            `Timed out waiting for Oracle conversation response ${options.conversationId}.`,
          ),
        );
      }, SUPERVISOR_CONVERSATION_RESPONSE_TIMEOUT_MS);
      const tryResolveLoadedResponse = (requestId: string) => {
        if (
          settled ||
          !matchedResponse ||
          matchedResponse.requestId !== requestId ||
          !finishedRequestIds.has(requestId)
        ) {
          return;
        }
        settled = true;
        cleanup();
        resolve(matchedResponse);
      };

      client.on("Network.requestWillBeSent", requestListener);
      client.on("Network.loadingFinished", loadingFinishedListener);
      client.on("Network.loadingFailed", loadingFailedListener);
      client.on("Network.responseReceived", responseReceivedListener);

      void (async () => {
        try {
          await Promise.all([Network.enable({}), Page.enable()]);
          const currentThread = await readCurrentSupervisorThread(Runtime);
          if (normalizeComparableUrl(currentThread.url) === normalizedThreadUrl) {
            await Page.reload({ ignoreCache: true });
          } else {
            await Page.navigate({ url: normalizedThreadUrl });
          }
        } catch (error) {
          settled = true;
          cleanup();
          reject(error);
        }
      })();
    },
  );

  if (expectedProjectId) {
    const requestProjectId = readHeaderValue(requestHeaders, "chatgpt-project-id");
    if (!projectIdsEquivalent(requestProjectId, expectedProjectId)) {
      throw new Error(
        `Oracle conversation response used project ${requestProjectId ?? "unknown"} instead of ${expectedProjectId}.`,
      );
    }
  }
  if (responseMatch.status !== 200) {
    throw new Error(
      `Oracle conversation response returned HTTP ${responseMatch.status} for ${options.conversationId}.`,
    );
  }

  const responseBody = await Network.getResponseBody({ requestId: responseMatch.requestId });
  const rawBody = responseBody.base64Encoded
    ? Buffer.from(responseBody.body, "base64").toString("utf8")
    : responseBody.body;
  return decodeConversationResponseHistory(JSON.parse(rawBody), options);
}

function isMissingSupervisorRuntimeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No reachable Oracle.*runtime session was found/i.test(message);
}

function buildSupervisorRuntimeBootstrapRequest(
  request: SupervisorBrokerRequest,
): SupervisorPromptRequest {
  const token = randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
  return {
    prompt: `Reply with exactly SUPERVISOR_RUNTIME_READY_${token} and nothing else.`,
    sessionSlug: `oracle-supervisor-bootstrap-${token.toLowerCase()}`,
    model: SUPERVISOR_RUNTIME_BOOTSTRAP_MODEL,
    browserModelStrategy: SUPERVISOR_RUNTIME_BOOTSTRAP_MODEL_STRATEGY,
    browserModelLabel: SUPERVISOR_RUNTIME_BOOTSTRAP_MODEL_LABEL,
    cwd: request.cwd,
  };
}

async function ensureSupervisorRuntimeReady(
  request: SupervisorBrokerRequest,
  runtimeDeps: SupervisorRuntimeDeps,
  promptRunner: NonNullable<SupervisorBrokerDeps["runPrompt"]>,
  options: SupervisorRuntimeUseOptions = {},
): Promise<void> {
  if (request.followupSession?.trim()) {
    return;
  }
  try {
    await runtimeDeps.resolveSupervisorRuntimeContext(undefined, options);
  } catch (error) {
    if (!isMissingSupervisorRuntimeError(error)) {
      throw error;
    }
    const bootstrap = await promptRunner(buildSupervisorRuntimeBootstrapRequest(request));
    if (!bootstrap.ok) {
      throw new Error(`Failed to bootstrap Oracle supervisor runtime: ${bootstrap.error}`);
    }
  }
}

function configuredSupervisorProjectUrl(
  meta: Awaited<ReturnType<typeof sessionStore.readSession>>,
): string | undefined {
  const envProjectUrl = process.env[SUPERVISOR_CHATGPT_URL_ENV]?.trim();
  if (envProjectUrl && isProjectUrl(envProjectUrl)) {
    return envProjectUrl;
  }
  return (
    meta?.browser?.config?.supervisorChatgptUrl ??
    meta?.browser?.config?.chatgptUrl ??
    meta?.browser?.config?.url ??
    undefined
  );
}

function filterSupervisorThreadsForBrokerProjectScope(
  threads: SupervisorThreadInfo[],
  projectUrl?: string,
): SupervisorThreadInfo[] {
  const normalizedProjectUrl = projectUrl?.trim();
  if (!normalizedProjectUrl) {
    return threads;
  }
  return threads.filter(
    (thread) =>
      Boolean(thread.url?.trim()) &&
      supervisorThreadMatchesProjectScope(thread, normalizedProjectUrl),
  );
}

function brokerListBrowseOptions(
  request: SupervisorBrokerRequest,
  configuredProjectUrl?: string,
):
  | {
      ok: true;
      rootScope: true;
      includeProjects: true;
      fallbackProjectUrl?: string;
      scopeUrl: string;
    }
  | { ok: true; projectUrl: string; scopeUrl: string }
  | { ok: false; error: string } {
  const requestedProjectUrl = request.projectUrl?.trim();
  const browseScope = request.browseScope ?? (requestedProjectUrl ? "project" : "root");
  if (browseScope === "root") {
    const fallbackProjectUrl =
      configuredProjectUrl?.trim() && isProjectUrl(configuredProjectUrl)
        ? configuredProjectUrl.trim()
        : undefined;
    return {
      ok: true,
      rootScope: true,
      includeProjects: true,
      ...(fallbackProjectUrl ? { fallbackProjectUrl } : {}),
      scopeUrl: CHATGPT_ROOT_URL,
    };
  }
  const projectUrl = requestedProjectUrl || configuredProjectUrl?.trim();
  if (!projectUrl) {
    return {
      ok: false,
      error: "projectUrl is required when browseScope is project.",
    };
  }
  return { ok: true, projectUrl, scopeUrl: projectUrl };
}

function conversationIdFromUrl(url?: string | null): string | undefined {
  return url?.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1]?.trim() || undefined;
}

function isProjectConversationUrl(url?: string | null): boolean {
  const trimmed = url?.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const pathname = new URL(trimmed).pathname.replace(/\/+$/, "");
    return /^\/g\/[^/]+(?:\/project)?\/c\/[a-zA-Z0-9-]+$/i.test(pathname);
  } catch {
    return /\/g\/[^/]+(?:\/project)?\/c\/[a-zA-Z0-9-]+\/?$/i.test(trimmed);
  }
}

function isRootConversationUrl(url?: string | null): boolean {
  const trimmed = url?.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const pathname = new URL(trimmed).pathname.replace(/\/+$/, "");
    return /^\/c\/[a-zA-Z0-9-]+$/i.test(pathname);
  } catch {
    return /\/c\/[a-zA-Z0-9-]+\/?$/i.test(trimmed) && !isProjectConversationUrl(trimmed);
  }
}

function supervisorProjectRow(projectUrl?: string): SupervisorBrowserEntry | undefined {
  const normalizedProjectUrl = normalizeComparableUrl(projectUrl);
  const projectId = extractProjectIdFromUrl(normalizedProjectUrl);
  if (!normalizedProjectUrl || !projectId) {
    return undefined;
  }
  return {
    kind: "project",
    title: "Oracle project",
    projectId,
    projectUrl: normalizedProjectUrl,
  };
}

function sessionRecencyMs(meta: SessionMetadata): number {
  for (const candidate of [meta.completedAt, meta.startedAt, meta.createdAt]) {
    const millis = Date.parse(candidate ?? "");
    if (Number.isFinite(millis)) {
      return millis;
    }
  }
  return 0;
}

function localRootThreadFromSession(
  meta: SessionMetadata,
): (SupervisorThreadInfo & { kind: "thread" }) | undefined {
  const binding = meta.supervisorThread;
  const runtime = meta.browser?.runtime;
  const progress = meta.progress;
  const url = binding?.url?.trim() || runtime?.tabUrl?.trim() || progress?.tabUrl?.trim();
  const conversationId =
    binding?.conversationId?.trim() ||
    runtime?.conversationId?.trim() ||
    progress?.conversationId?.trim() ||
    conversationIdFromUrl(url);
  if (!conversationId) {
    return undefined;
  }
  if (isProjectUrl(binding?.projectUrl) || isProjectConversationUrl(url)) {
    return undefined;
  }
  const threadUrl = isRootConversationUrl(url) ? url : `https://chatgpt.com/c/${conversationId}`;
  return {
    kind: "thread",
    title: meta.promptPreview?.trim() || `ChatGPT conversation ${conversationId}`,
    conversationId,
    url: threadUrl,
  };
}

async function listLocalRootSupervisorThreads(): Promise<
  (SupervisorThreadInfo & { kind: "thread" })[]
> {
  const sessions = await sessionStore.listSessions();
  return sessions
    .map((meta) => ({ meta, thread: localRootThreadFromSession(meta) }))
    .filter(
      (
        entry,
      ): entry is { meta: SessionMetadata; thread: SupervisorThreadInfo & { kind: "thread" } } =>
        entry.thread !== undefined,
    )
    .sort((left, right) => sessionRecencyMs(right.meta) - sessionRecencyMs(left.meta))
    .map((entry) => entry.thread);
}

function entryDedupeKey(entry: SupervisorBrowserEntry): string {
  if (entry.kind === "project") {
    const projectId =
      normalizeProjectIdForComparison(entry.projectId) ??
      normalizeProjectIdForComparison(extractProjectIdFromUrl(entry.projectUrl));
    return projectId
      ? `project:${projectId}`
      : `project:${normalizeComparableUrl(entry.projectUrl) ?? entry.projectUrl}`;
  }
  const conversationId = entry.conversationId?.trim();
  if (conversationId) {
    return `thread:${conversationId}`;
  }
  return `url:${normalizeComparableUrl(entry.url) ?? entry.url ?? entry.title}`;
}

function dedupeSupervisorBrowserEntries(
  entries: SupervisorBrowserEntry[],
): SupervisorBrowserEntry[] {
  const seen = new Set<string>();
  const result: SupervisorBrowserEntry[] = [];
  for (const entry of entries) {
    const key = entryDedupeKey(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

async function rootListThreadsWithLocalFallback(
  liveEntries: SupervisorBrowserEntry[],
  configuredProjectUrl?: string,
  options: { forceLocalFallback?: boolean } = {},
): Promise<SupervisorBrowserEntry[]> {
  const liveRootThreads = liveEntries.filter(
    (entry) => entry.kind === "thread" && !isProjectConversationUrl(entry.url),
  );
  const projectEntries = liveEntries.filter((entry) => entry.kind === "project");
  const projectRow = supervisorProjectRow(configuredProjectUrl);
  const fallbackThreads =
    options.forceLocalFallback || liveRootThreads.length === 0
      ? await listLocalRootSupervisorThreads()
      : [];
  return dedupeSupervisorBrowserEntries([
    ...liveRootThreads,
    ...fallbackThreads,
    ...(projectRow ? [projectRow] : []),
    ...projectEntries,
  ]);
}

async function withChromeFocusProtection<T>(
  chromePid: number | undefined,
  action: () => Promise<T>,
  deps: ChromeFocusDeps = chromeFocusDeps,
): Promise<T> {
  if (process.platform !== "darwin" || !chromePid) {
    return action();
  }
  const chrome = { pid: chromePid } as LaunchedChrome;
  const stopFocusGuard = deps.startChromeFocusGuard(chrome, supervisorChromeLogger);
  try {
    await deps.hideChromeWindow(chrome, supervisorChromeLogger).catch(() => undefined);
    return await action();
  } finally {
    await deps.finalizeChromeFocusProtection(chrome, supervisorChromeLogger, stopFocusGuard);
  }
}

async function withSupervisorRuntime<T>(
  request: SupervisorBrokerRequest,
  action: (args: {
    client: SupervisorRuntimeClient;
    Runtime: Awaited<ReturnType<typeof connectSupervisorRuntime>>["client"]["Runtime"];
    sessionId: string;
    targetId?: string | null;
  }) => Promise<T>,
  runtimeDeps: SupervisorRuntimeDeps = supervisorRuntimeDeps,
  focusDeps: ChromeFocusDeps = chromeFocusDeps,
  promptRunner: NonNullable<SupervisorBrokerDeps["runPrompt"]> = runSupervisorPromptOperation,
  options: SupervisorRuntimeUseOptions = {},
): Promise<T> {
  const runtimeOptions = resolveSupervisorRuntimeUseOptions(options);
  await ensureSupervisorRuntimeReady(request, runtimeDeps, promptRunner, runtimeOptions);
  return await runtimeDeps.withSupervisorRuntimeAttachLease(supervisorChromeLogger, async () => {
    const context = await runtimeDeps.resolveSupervisorRuntimeContext(
      request.followupSession,
      runtimeOptions,
    );
    return await withChromeFocusProtection(
      context.runtime.chromePid,
      async () => {
        const connection = await runtimeDeps.connectSupervisorRuntime(
          context.runtime,
          runtimeOptions,
        );
        try {
          return await action({
            client: connection.client,
            Runtime: connection.client.Runtime,
            sessionId: context.sessionId,
            targetId: connection.persistTargetId === false ? null : connection.targetId,
          });
        } finally {
          await connection.close();
        }
      },
      focusDeps,
    );
  });
}

async function syncSupervisorRuntimeSession(
  sessionId: string,
  thread: SupervisorThreadInfo,
  targetId?: string | null,
): Promise<void> {
  const meta = await sessionStore.readSession(sessionId);
  const runtime = meta?.browser?.runtime;
  if (!runtime) {
    throw new Error(`Supervisor runtime session ${sessionId} is missing browser metadata.`);
  }
  if (!supervisorThreadMatchesProjectScope(thread, configuredSupervisorProjectUrl(meta))) {
    throw new Error(
      `Refusing to persist Oracle supervisor thread ${thread.conversationId} outside the configured project scope.`,
    );
  }
  await sessionStore.updateSession(sessionId, {
    browser: {
      config: meta.browser?.config,
      runtime: {
        ...runtime,
        chromeTargetId: targetId === undefined ? runtime.chromeTargetId : targetId || undefined,
        tabUrl: thread.url ?? runtime.tabUrl,
        conversationId: thread.conversationId,
      },
    },
  });
}

function supervisorThreadSessionSlug(thread: SupervisorThreadInfo): string {
  const source = thread.conversationId?.trim() || thread.title.trim() || "chatgpt";
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `oracle-thread-${normalized || "chatgpt"}`;
}

function buildSupervisorThreadBinding(
  meta: Awaited<ReturnType<typeof sessionStore.readSession>>,
  thread: SupervisorThreadInfo,
): SupervisorThreadBindingMetadata {
  const conversationId = thread.conversationId?.trim();
  if (!conversationId) {
    throw new Error("Oracle supervisor thread binding requires a concrete conversation id.");
  }
  return {
    conversationId,
    url: thread.url?.trim() || undefined,
    projectUrl: configuredSupervisorProjectUrl(meta),
    verifiedAt: new Date().toISOString(),
  };
}

function normalizeRequestedThreadUrlCandidate(
  requestedConversationId: string,
  projectUrl: string | undefined,
  candidate: { url?: string | null; conversationId?: string | null } | null | undefined,
): string | undefined {
  const url = candidate?.url?.trim();
  if (!url) {
    return undefined;
  }
  const normalized = normalizeSupervisorThread({
    url,
    conversationId: candidate?.conversationId?.trim() || undefined,
    title: "Oracle thread",
  });
  if (
    !normalized ||
    normalized.conversationId?.trim() !== requestedConversationId ||
    !supervisorThreadMatchesProjectScope(normalized, projectUrl)
  ) {
    return undefined;
  }
  return url;
}

function normalizeSupervisorHistoryLimit(limit?: number): number {
  const numeric =
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.trunc(limit)
      : SUPERVISOR_HISTORY_LIMIT_DEFAULT;
  return Math.min(SUPERVISOR_HISTORY_LIMIT_MAX, Math.max(1, numeric));
}

function normalizeBackendMessageText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r/g, "").trim() : "";
}

function extractBackendMessageTextPart(value: unknown): string {
  if (typeof value === "string") {
    return normalizeBackendMessageText(value);
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  const directFields = [record.text, record.content, record.value, record.body];
  for (const candidate of directFields) {
    const text = normalizeBackendMessageText(candidate);
    if (text) {
      return text;
    }
  }
  const nestedCollections = [record.parts, record.content, record.items, record.output];
  for (const collection of nestedCollections) {
    const text = extractBackendMessageTextCollection(collection);
    if (text) {
      return text;
    }
  }
  return "";
}

function extractBackendMessageTextCollection(value: unknown): string {
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => extractBackendMessageTextPart(part))
      .filter((part) => part.length > 0);
    return parts.join("\n\n").trim();
  }
  return extractBackendMessageTextPart(value);
}

function extractBackendConversationMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    const partsText = extractBackendMessageTextCollection(record.parts);
    if (partsText) {
      return partsText;
    }
    const textFields = [record.text, record.result, record.output_text];
    for (const candidate of textFields) {
      const text = extractBackendMessageTextCollection(candidate);
      if (text) {
        return text;
      }
    }
  }
  const fallbackFields = [message.text, message.content, message.result, message.output_text];
  for (const candidate of fallbackFields) {
    const text = extractBackendMessageTextCollection(candidate);
    if (text) {
      return text;
    }
  }
  return "";
}

function extractBackendConversationMessageRole(
  message: Record<string, unknown>,
): "user" | "assistant" | null {
  const author = message.author;
  const authorRole =
    author && typeof author === "object"
      ? normalizeBackendMessageText((author as Record<string, unknown>).role).toLowerCase()
      : "";
  const directRole = normalizeBackendMessageText(message.role).toLowerCase();
  const role = authorRole || directRole;
  return role === "user" || role === "assistant" ? role : null;
}

function parseBackendConversationHistoryEntries(
  body: unknown,
  expectedConversationId: string,
): SupervisorThreadHistoryEntry[] {
  if (!body || typeof body !== "object") {
    return [];
  }
  const record = body as Record<string, unknown>;
  const backendConversationId = normalizeBackendMessageText(record.conversation_id);
  if (backendConversationId && backendConversationId !== expectedConversationId) {
    return [];
  }
  const mapping = record.mapping;
  if (!mapping || typeof mapping !== "object") {
    return [];
  }
  const rawEntries: Array<{
    role: "user" | "assistant";
    text: string;
    createdAt: number;
    index: number;
  }> = [];
  let fallbackIndex = 0;
  for (const node of Object.values(mapping as Record<string, unknown>)) {
    if (!node || typeof node !== "object") {
      continue;
    }
    const nodeRecord = node as Record<string, unknown>;
    const message = nodeRecord.message;
    if (!message || typeof message !== "object") {
      continue;
    }
    const messageRecord = message as Record<string, unknown>;
    const role = extractBackendConversationMessageRole(messageRecord);
    if (!role) {
      continue;
    }
    const text = extractBackendConversationMessageText(messageRecord);
    if (!text) {
      continue;
    }
    const createTimeCandidate = messageRecord.create_time ?? nodeRecord.create_time;
    const createTimeNumeric =
      typeof createTimeCandidate === "number"
        ? createTimeCandidate
        : Number.parseFloat(String(createTimeCandidate ?? ""));
    rawEntries.push({
      role,
      text,
      createdAt: Number.isFinite(createTimeNumeric) ? createTimeNumeric : Number.POSITIVE_INFINITY,
      index: fallbackIndex,
    });
    fallbackIndex += 1;
  }
  rawEntries.sort((left, right) =>
    left.createdAt === right.createdAt
      ? left.index - right.index
      : left.createdAt - right.createdAt,
  );
  const deduped: SupervisorThreadHistoryEntry[] = [];
  for (const entry of rawEntries) {
    const last = deduped.at(-1);
    if (last && last.role === entry.role && last.text === entry.text) {
      continue;
    }
    deduped.push({ role: entry.role, text: entry.text });
  }
  return deduped;
}

function selectProjectScopedHistoryFallback(args: {
  projectUrl?: string;
  expectedConversationId: string;
  requestedLimit?: number;
  placeholderShellUnderfill?: boolean;
  domHistory: SupervisorThreadHistoryEntry[];
  backendBody: unknown;
}): {
  history: SupervisorThreadHistoryEntry[];
  historyWindow: SupervisorThreadHistoryWindow;
} | null {
  if (!args.projectUrl?.trim() || args.placeholderShellUnderfill !== true) {
    return null;
  }
  const limit = normalizeSupervisorHistoryLimit(args.requestedLimit);
  const domHistory = Array.isArray(args.domHistory) ? args.domHistory : [];
  if (domHistory.length >= limit) {
    return null;
  }
  const backendHistory = parseBackendConversationHistoryEntries(
    args.backendBody,
    args.expectedConversationId,
  );
  if (backendHistory.length <= domHistory.length) {
    return null;
  }
  const limited = backendHistory.slice(-limit);
  return {
    history: limited,
    historyWindow: {
      limit,
      returnedCount: limited.length,
      totalCount: backendHistory.length,
      truncated: backendHistory.length > limited.length,
    },
  };
}

async function recoverProjectScopedSupervisorThreadHistoryFromBackendApi(
  runtime: SupervisorRuntimeClient,
  args: {
    projectUrl?: string;
    expectedConversationId: string;
    requestedLimit?: number;
    domHistory: SupervisorThreadHistoryEntry[];
    threadUrl?: string;
    placeholderShellUnderfill?: boolean;
  },
): Promise<{
  history: SupervisorThreadHistoryEntry[];
  historyWindow: SupervisorThreadHistoryWindow;
} | null> {
  if (!args.projectUrl?.trim() || args.placeholderShellUnderfill !== true) {
    return null;
  }
  const limit = normalizeSupervisorHistoryLimit(args.requestedLimit);
  if (args.domHistory.length >= limit) {
    return null;
  }

  const threadUrl = args.threadUrl?.trim();
  if (threadUrl) {
    const candidateThread = normalizeSupervisorThread({
      title: "Oracle thread",
      url: threadUrl,
      conversationId: args.expectedConversationId,
    });
    if (candidateThread && supervisorThreadMatchesProjectScope(candidateThread, args.projectUrl)) {
      const client = runtime as SupervisorRuntimeClient;
      if (client.Network && client.Page && client.Runtime) {
        try {
          const recovered = await readProjectConversationHistoryFromResponse(client, {
            conversationId: args.expectedConversationId,
            threadUrl,
            projectUrl: args.projectUrl,
            limit: limit,
          });
          if (recovered.history.length > args.domHistory.length) {
            return recovered;
          }
          return null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            message.includes("while") &&
            message.includes("requested") &&
            message.includes("conversation response returned")
          ) {
            throw error;
          }
          if (message.includes("used project") && message.includes("instead of")) {
            throw error;
          }
        }
      }
    }
  }

  return null;
}

async function resolveRequestedThreadUrl(
  request: SupervisorBrokerRequest,
  runtimeSessionMeta: SessionMetadata | null,
): Promise<string | undefined> {
  const requestedConversationId = request.conversationId?.trim();
  if (!requestedConversationId) {
    return undefined;
  }
  const projectUrl = configuredSupervisorProjectUrl(runtimeSessionMeta);
  const explicit = normalizeRequestedThreadUrlCandidate(requestedConversationId, projectUrl, {
    url: request.threadUrl,
    conversationId: requestedConversationId,
  });
  if (explicit) {
    return explicit;
  }
  const followupSessionId = request.followupSession?.trim();
  if (!followupSessionId) {
    return undefined;
  }
  const followupMeta = await sessionStore.readSession(followupSessionId).catch(() => null);
  return (
    normalizeRequestedThreadUrlCandidate(
      requestedConversationId,
      projectUrl,
      followupMeta?.supervisorThread,
    ) ??
    normalizeRequestedThreadUrlCandidate(requestedConversationId, projectUrl, {
      url: followupMeta?.browser?.runtime?.tabUrl,
      conversationId: followupMeta?.browser?.runtime?.conversationId,
    })
  );
}

function assertReusableSupervisorThreadBinding(
  sessionId: string,
  meta: SessionMetadata | null,
  thread: SupervisorThreadInfo,
): void {
  const boundConversationId = meta?.supervisorThread?.conversationId?.trim();
  if (boundConversationId && boundConversationId !== thread.conversationId) {
    throw new Error(
      `Session ${sessionId} is already bound to Oracle conversation ${boundConversationId}; refusing to reuse it for ${thread.conversationId}.`,
    );
  }
}

function isReusableSupervisorThreadSession(
  sessionId: string,
  meta: SessionMetadata | null,
): boolean {
  const parentSessionId = meta?.options?.followupSessionId?.trim();
  const prompt = meta?.options?.prompt?.trim() || meta?.promptPreview?.trim() || "";
  return (
    Boolean(meta?.browser?.runtime) &&
    meta?.mode === "browser" &&
    Boolean(parentSessionId) &&
    parentSessionId !== sessionId &&
    prompt.startsWith(SUPERVISOR_THREAD_PROMPT_PREFIX)
  );
}

async function createSupervisorThreadSession(
  sessionId: string,
  thread: SupervisorThreadInfo,
  targetId?: string | null,
): Promise<string> {
  const meta = await sessionStore.readSession(sessionId);
  const runtime = meta?.browser?.runtime;
  if (!meta || !runtime) {
    throw new Error(`Supervisor runtime session ${sessionId} is missing browser metadata.`);
  }
  if (!supervisorThreadMatchesProjectScope(thread, configuredSupervisorProjectUrl(meta))) {
    throw new Error(
      "Refusing to create an Oracle supervisor thread session outside the configured project scope.",
    );
  }

  const browser = {
    config: meta.browser?.config,
    runtime: {
      ...runtime,
      chromeTargetId: targetId === undefined ? runtime.chromeTargetId : targetId || undefined,
      tabUrl: thread.url ?? runtime.tabUrl,
      conversationId: thread.conversationId,
    },
  };
  const supervisorThread = buildSupervisorThreadBinding(meta, thread);

  const model = meta.options.model ?? meta.options.effectiveModelId ?? meta.model ?? "gpt-5.5-pro";
  const created = await sessionStore.createSession(
    {
      prompt: `Supervisor thread: ${thread.title}`,
      model,
      models: meta.options.models,
      mode: "browser",
      browserConfig: browser.config,
      followupSessionId: sessionId,
      effectiveModelId: meta.options.effectiveModelId ?? model,
      search: meta.options.search,
      silent: true,
      waitPreference: true,
    },
    meta.cwd ?? process.cwd(),
    meta.notifications,
    supervisorThreadSessionSlug(thread),
  );

  await sessionStore.updateSession(created.id, {
    status: "completed",
    browser,
    supervisorThread,
    promptPreview: `Supervisor thread: ${thread.title}`,
    mode: "browser",
    completedAt: new Date().toISOString(),
  });
  return created.id;
}

async function createAndSyncSupervisorThreadSession(
  sessionId: string,
  thread: SupervisorThreadInfo,
  targetId?: string | null,
): Promise<string> {
  await syncSupervisorRuntimeSession(sessionId, thread, targetId);
  return await createSupervisorThreadSession(sessionId, thread, targetId);
}

async function ensureSupervisorThreadSession(
  sessionId: string,
  thread: SupervisorThreadInfo,
  targetId?: string | null,
): Promise<string> {
  const meta = await sessionStore.readSession(sessionId);
  assertReusableSupervisorThreadBinding(sessionId, meta, thread);
  if (isReusableSupervisorThreadSession(sessionId, meta)) {
    const parentSessionId = meta?.options?.followupSessionId?.trim();
    if (!meta || !parentSessionId) {
      throw new Error(`Supervisor thread session ${sessionId} is missing followup metadata.`);
    }
    await syncSupervisorRuntimeSession(sessionId, thread, targetId);
    await sessionStore.updateSession(sessionId, {
      supervisorThread: buildSupervisorThreadBinding(meta, thread),
    });
    await syncSupervisorRuntimeSession(parentSessionId, thread, targetId);
    return sessionId;
  }
  const parentSessionId = meta?.options?.followupSessionId?.trim();
  if (parentSessionId && parentSessionId !== sessionId) {
    return await createAndSyncSupervisorThreadSession(parentSessionId, thread, targetId);
  }
  return await createAndSyncSupervisorThreadSession(sessionId, thread, targetId);
}

function normalizeOperation(request: SupervisorBrokerRequest): SupervisorBrokerOperation {
  return request.operation ?? request.action ?? "run_prompt";
}

function unsupportedOperationResponse(operation: string): SupervisorBrokerResponse {
  return {
    ok: false,
    error: `Unsupported supervisor operation: ${operation}`,
  };
}

function assertRequestedConversationIdentity(
  operation: "attach_thread" | "thread_history",
  requestedConversationId: string,
  thread: SupervisorThreadInfo,
): void {
  const actualConversationId = thread.conversationId?.trim();
  if (!actualConversationId || actualConversationId !== requestedConversationId) {
    throw new Error(
      `Oracle ${operation} resolved conversation ${actualConversationId ?? "unknown"} while ${requestedConversationId} was requested.`,
    );
  }
  const urlConversationId = (thread.url?.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1] ?? "").trim();
  if (urlConversationId && urlConversationId !== requestedConversationId) {
    throw new Error(
      `Oracle ${operation} resolved URL conversation ${urlConversationId} while ${requestedConversationId} was requested.`,
    );
  }
}

export async function runSupervisorBrokerRequest(
  request: SupervisorBrokerRequest,
  deps: SupervisorBrokerDeps = {},
): Promise<SupervisorBrokerResponse> {
  try {
    const promptRunner = deps.runPrompt ?? runSupervisorPromptOperation;
    const operation = normalizeOperation(request);
    switch (operation) {
      case "run_prompt":
        return promptRunner(request);
      case "list_threads":
        return (
          deps.listThreads ??
          (async (incoming: SupervisorBrokerRequest) => {
            const browseScope =
              incoming.browseScope ?? (incoming.projectUrl?.trim() ? "project" : "root");
            const dedicatedHiddenTargetUrl =
              browseScope === "root" ? CHATGPT_ROOT_URL : incoming.projectUrl?.trim();
            return withSupervisorRuntime(
              incoming,
              async ({ Runtime, sessionId }) => {
                const meta = await sessionStore.readSession(sessionId);
                const browseOptions = brokerListBrowseOptions(
                  incoming,
                  configuredSupervisorProjectUrl(meta),
                );
                if (!browseOptions.ok) {
                  return { ok: false as const, error: browseOptions.error };
                }
                if (browseScope === "root") {
                  let liveEntries: SupervisorBrowserEntry[] = [];
                  let liveError: unknown;
                  try {
                    liveEntries = await listSupervisorBrowserEntries(Runtime, browseOptions);
                  } catch (error) {
                    liveError = error;
                  }
                  const threads = await rootListThreadsWithLocalFallback(
                    liveEntries,
                    configuredSupervisorProjectUrl(meta),
                    { forceLocalFallback: liveError !== undefined },
                  );
                  if (threads.length === 0 && liveError) {
                    throw liveError;
                  }
                  if (threads.length === 0) {
                    throw new Error(
                      "No Oracle supervisor root threads, local root sessions, or configured project rows were available.",
                    );
                  }
                  return {
                    ok: true as const,
                    threads,
                  };
                }
                return {
                  ok: true as const,
                  threads: await listSupervisorBrowserEntries(Runtime, browseOptions),
                };
              },
              supervisorRuntimeDeps,
              chromeFocusDeps,
              promptRunner,
              {
                allowChatgptShellRecovery: browseScope === "root",
                dedicatedHiddenTargetUrl,
              },
            );
          })
        )(request);
      case "new_thread":
        return (
          deps.newThread ??
          (async (incoming: SupervisorBrokerRequest) =>
            withSupervisorRuntime(
              incoming,
              async ({ Runtime, sessionId, targetId }) => {
                const meta = await sessionStore.readSession(sessionId);
                const thread = await newSupervisorThread(Runtime, {
                  projectUrl: configuredSupervisorProjectUrl(meta),
                });
                const threadSessionId = await createAndSyncSupervisorThreadSession(
                  sessionId,
                  thread,
                  targetId,
                );
                return {
                  ok: true as const,
                  thread,
                  sessionId: threadSessionId,
                };
              },
              supervisorRuntimeDeps,
              chromeFocusDeps,
              promptRunner,
              { allowChatgptShellRecovery: true },
            ))
        )(request);
      case "attach_thread": {
        const conversationId = request.conversationId?.trim();
        if (!conversationId) {
          return {
            ok: false,
            error: "conversationId is required for attach_thread.",
          };
        }
        const dedicatedHiddenTargetUrl = request.threadUrl?.trim();
        return (
          deps.attachThread ??
          (async (incoming: SupervisorBrokerRequest) =>
            withSupervisorRuntime(
              incoming,
              async ({ Runtime, sessionId, targetId }) => {
                const meta = await sessionStore.readSession(sessionId);
                const threadUrl = await resolveRequestedThreadUrl(incoming, meta);
                const thread = await attachSupervisorThread(Runtime, conversationId, {
                  projectUrl: configuredSupervisorProjectUrl(meta),
                  threadUrl,
                });
                assertRequestedConversationIdentity("attach_thread", conversationId, thread);
                const threadSessionId = await ensureSupervisorThreadSession(
                  sessionId,
                  thread,
                  targetId,
                );
                return {
                  ok: true as const,
                  thread,
                  sessionId: threadSessionId,
                };
              },
              supervisorRuntimeDeps,
              chromeFocusDeps,
              promptRunner,
              {
                allowChatgptShellRecovery: true,
                ...(dedicatedHiddenTargetUrl ? { dedicatedHiddenTargetUrl } : {}),
              },
            ))
        )(request);
      }
      case "thread_history": {
        const conversationId = request.conversationId?.trim();
        if (!conversationId) {
          return {
            ok: false,
            error: "conversationId is required for thread_history.",
          };
        }
        const dedicatedHiddenTargetUrl = request.threadUrl?.trim();
        return (
          deps.threadHistory ??
          (async (incoming: SupervisorBrokerRequest) =>
            withSupervisorRuntime(
              incoming,
              async ({ client, Runtime, sessionId, targetId }) => {
                const meta = await sessionStore.readSession(sessionId);
                const projectUrl = configuredSupervisorProjectUrl(meta);
                const threadUrl = await resolveRequestedThreadUrl(incoming, meta);
                const result = await readAttachedSupervisorThreadHistory(Runtime, {
                  conversationId,
                  projectUrl,
                  threadUrl,
                  limit: incoming.historyLimit,
                });
                assertRequestedConversationIdentity(
                  "thread_history",
                  conversationId,
                  result.thread,
                );
                const backendRecoveredHistory =
                  await recoverProjectScopedSupervisorThreadHistoryFromBackendApi(client, {
                    projectUrl,
                    expectedConversationId: conversationId,
                    requestedLimit: incoming.historyLimit,
                    domHistory: result.history,
                    threadUrl: threadUrl ?? result.thread.url,
                    placeholderShellUnderfill: result.placeholderShellUnderfill,
                  });
                if (result.placeholderShellUnderfill && !backendRecoveredHistory) {
                  throw new Error(
                    `Oracle supervisor thread history for ${conversationId} remained underfilled after backend recovery.`,
                  );
                }
                const threadSessionId = await ensureSupervisorThreadSession(
                  sessionId,
                  result.thread,
                  targetId,
                );
                return {
                  ok: true as const,
                  thread: result.thread,
                  sessionId: threadSessionId,
                  history: backendRecoveredHistory?.history ?? result.history,
                  historyWindow: backendRecoveredHistory?.historyWindow ?? result.historyWindow,
                };
              },
              supervisorRuntimeDeps,
              chromeFocusDeps,
              promptRunner,
              {
                allowChatgptShellRecovery: true,
                ...(dedicatedHiddenTargetUrl ? { dedicatedHiddenTargetUrl } : {}),
              },
            ))
        )(request);
      }
      default:
        return unsupportedOperationResponse(operation);
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function startSupervisorBroker(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const releaseCleanup = installSupervisorBrokerBrowserbaseReleaseCleanup();
  const stopInput = () => {
    rl.close();
    process.stdin.pause();
    process.stdin.unref?.();
  };
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let request: SupervisorBrokerRequest;
      try {
        request = JSON.parse(trimmed) as SupervisorBrokerRequest;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await writeSupervisorBrokerResponseLine({ ok: false, error: message });
        continue;
      }
      if (request.shutdown) {
        await releaseCleanup.release();
        stopInput();
        return;
      }
      const response = await runSupervisorBrokerRequest(request);
      await writeSupervisorBrokerResponseLine(response);
    }
  } finally {
    await releaseCleanup.release();
    stopInput();
  }
}

export const __test__ = {
  buildSupervisorRuntimeBootstrapRequest,
  brokerListBrowseOptions,
  configuredSupervisorProjectUrl,
  rootListThreadsWithLocalFallback,
  listLocalRootSupervisorThreads,
  ensureSupervisorRuntimeReady,
  withChromeFocusProtection,
  withSupervisorRuntime,
  syncSupervisorRuntimeSession,
  createSupervisorThreadSession,
  createAndSyncSupervisorThreadSession,
  ensureSupervisorThreadSession,
  filterSupervisorThreadsForBrokerProjectScope,
  normalizeSupervisorHistoryLimit,
  parseBackendConversationHistoryEntries,
  recoverProjectScopedSupervisorThreadHistoryFromBackendApi,
  resolveRequestedThreadUrl,
  selectProjectScopedHistoryFallback,
  isReusableSupervisorThreadSession,
  installSupervisorBrokerBrowserbaseReleaseCleanup,
  releaseBrowserbaseSupervisorRuntimesForBrokerShutdown,
  supervisorBrokerSignalExitCode,
  supervisorThreadSessionSlug,
  writeSupervisorBrokerResponseLine,
};
