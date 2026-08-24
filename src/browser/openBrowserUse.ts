import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  OpenBrowserUseClient,
  type BrowserUseRequestParams,
  type JsonValue,
  type OpenBrowserUseNotification,
} from "open-browser-use-sdk";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import { ensureChatGptIdentity, assertChatGptIdentity } from "./chatgptAccountRouter.js";
import type {
  ChatGptIdentityEvidence,
  ChatGptIdentityExpectation,
} from "./chatgptAccountRouter.js";
import {
  chatGptConversationScopeFromUrl,
  isSameChatGptConversationScope,
} from "./conversationUrl.js";
import {
  ensureChatGptScopeRetained,
  ensureNotBlocked,
  navigateToChatGPT,
} from "./actions/navigation.js";
import { acquireProfileRunLock, isProcessAlive, type ProfileRunLock } from "./profileState.js";
import { delay } from "./utils.js";
import type { BrowserLogger, ChromeClient } from "./types.js";
import { withTimeout } from "./reattachHelpers.js";

const ACTIVE_REGISTRY_PATH = "/tmp/open-browser-use/active.json";
const ACTIVE_SOCKET_ROOT = "/tmp/open-browser-use";
export const REQUIRED_OPEN_BROWSER_USE_VERSION = "0.1.41";

interface ActiveSocketRecord {
  socketPath?: unknown;
  pid?: unknown;
}

interface ObuTab {
  id: number;
  url?: string;
  title?: string;
}

export interface OpenBrowserUseClientLike {
  sessionId: string;
  connect(): Promise<unknown>;
  close(): void;
  onNotification(handler: (notification: OpenBrowserUseNotification) => void): () => void;
  request(method: string, params?: BrowserUseRequestParams): Promise<JsonValue>;
  getInfo(): Promise<JsonValue>;
  nameSession(name: string): Promise<JsonValue>;
  createTab(): Promise<JsonValue>;
  getTabs(): Promise<JsonValue>;
  attach(tabId: number): Promise<JsonValue>;
  finalizeTabs(keep: JsonValue[]): Promise<JsonValue>;
  turnEnded(): Promise<JsonValue>;
}

export interface OpenBrowserUseConnection {
  client: ChromeClient;
  obuClient: OpenBrowserUseClientLike;
  sessionId: string;
  tabId: number;
  tabUrl?: string;
  created: boolean;
  finalize(keepTab: boolean): Promise<void>;
  requestKeepTab?: () => void;
}
export interface StoredOpenBrowserUseTabAffinity {
  sessionId: string;
  tabId: number;
  email: string;
  workspaceName: string;
  accountDigest: string;
  workspaceDigest: string;
}

export interface StoredOpenBrowserUseAffinity extends StoredOpenBrowserUseTabAffinity {
  conversationUrl: string;
}

export type OpenBrowserUseTerminationHooks = (() => void) & {
  waitForDrain: () => Promise<void>;
  isTerminating: () => boolean;
  isLockUncertain: () => boolean;
};

type TerminationConnection = Pick<OpenBrowserUseConnection, "finalize" | "requestKeepTab"> &
  Partial<Pick<OpenBrowserUseConnection, "sessionId" | "tabId" | "tabUrl">>;

export function registerOpenBrowserUseTerminationHooks(options: {
  connection: () => TerminationConnection | Promise<TerminationConnection | null> | null;
  beforeFinalize?: () => Promise<void>;
  preserveTab?: () => void;
  releaseLock: () => Promise<void>;
  markLockUncertain?: (details: {
    reason: string;
    recoveryHandle?: Record<string, unknown>;
  }) => Promise<void> | void;
  logger: BrowserLogger;
  drainTimeoutMs?: number;
}): OpenBrowserUseTerminationHooks {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGQUIT"];
  const listeners = new Map<NodeJS.Signals, () => void>();
  let handling = false;
  let removed = false;
  let terminating = false;
  let lockUncertain = false;
  const configuredDrainTimeoutMs = options.drainTimeoutMs;
  const drainTimeoutMs =
    typeof configuredDrainTimeoutMs === "number" && Number.isFinite(configuredDrainTimeoutMs)
      ? Math.max(1, configuredDrainTimeoutMs)
      : 30_000;
  let signalTask: Promise<void> | null = null;
  let connectionPromise: Promise<TerminationConnection | null> | null = null;
  let connectionSettled = false;
  let beforeFinalizePromise: Promise<void> | null = null;
  let beforeFinalizeSettled = false;
  let finalizePromise: Promise<void> | null = null;
  let latePreservationScheduled = false;
  let uncertaintyDetails: {
    reason: string;
    recoveryHandle?: Record<string, unknown>;
  } | null = null;
  let uncertaintyPersistPromise: Promise<void> | null = null;
  const resolveConnection = (): Promise<TerminationConnection | null> => {
    connectionPromise ??= Promise.resolve()
      .then(() => options.connection())
      .finally(() => {
        connectionSettled = true;
      });
    void connectionPromise.catch(() => undefined);
    return connectionPromise;
  };
  const runBeforeFinalize = (): Promise<void> => {
    beforeFinalizePromise ??= Promise.resolve()
      .then(() => options.beforeFinalize?.())
      .then(() => undefined)
      .finally(() => {
        beforeFinalizeSettled = true;
      });
    void beforeFinalizePromise.catch(() => undefined);
    return beforeFinalizePromise;
  };
  const runFinalize = (connection: TerminationConnection): Promise<void> => {
    finalizePromise ??= Promise.resolve()
      .then(() => connection.finalize(true))
      .then(() => undefined);
    void finalizePromise.catch(() => undefined);
    return finalizePromise;
  };
  const buildRecoveryHandle = (connection: TerminationConnection | null) => {
    if (!connection || connection.sessionId === undefined || connection.tabId === undefined) {
      return undefined;
    }
    return {
      transport: "obu",
      sessionId: connection.sessionId,
      tabId: connection.tabId,
      conversationUrl: connection.tabUrl ?? null,
    };
  };
  const recoveryHandleFromError = (error: unknown): Record<string, unknown> | undefined => {
    if (!(error instanceof BrowserAutomationError)) return undefined;
    const candidate = error.details?.recoveryHandle;
    return candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : undefined;
  };
  const persistUncertainty = async (): Promise<void> => {
    lockUncertain = true;
    if (!uncertaintyDetails) {
      uncertaintyDetails = { reason: "Open Browser Use termination cleanup was inconclusive." };
    }
    const pending = uncertaintyPersistPromise
      ? uncertaintyPersistPromise.catch(() => undefined)
      : Promise.resolve();
    uncertaintyPersistPromise = pending.then(async () => {
      await withTimeout(
        Promise.resolve().then(() => options.markLockUncertain?.(uncertaintyDetails!)),
        Math.min(5_000, drainTimeoutMs),
        "Open Browser Use uncertain-lock persistence timed out",
      );
    });
    void uncertaintyPersistPromise.catch(() => undefined);
    try {
      await uncertaintyPersistPromise;
    } catch (error) {
      options.logger(
        `[browser] Failed to persist the uncertain main-Chrome routing lock: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const noteUncertainty = async (
    reason: string,
    connection: TerminationConnection | null = null,
    recoveryHandle?: Record<string, unknown>,
  ): Promise<void> => {
    const handle = recoveryHandle ?? buildRecoveryHandle(connection);
    uncertaintyDetails = {
      ...(uncertaintyDetails ?? { reason }),
      ...(handle ? { recoveryHandle: handle } : {}),
    };
    await persistUncertainty();
  };
  const scheduleLatePreservation = (): void => {
    if (latePreservationScheduled) return;
    latePreservationScheduled = true;
    const lateTask = (async () => {
      let connection: TerminationConnection | null = null;
      try {
        connection = await resolveConnection();
        if (!connection) return;
        const recoveryHandle = buildRecoveryHandle(connection);
        if (recoveryHandle) {
          uncertaintyDetails = {
            ...(uncertaintyDetails ?? {
              reason: "Open Browser Use termination cleanup was inconclusive.",
            }),
            recoveryHandle,
          };
          await persistUncertainty();
        }
        connection.requestKeepTab?.();
        try {
          await runBeforeFinalize();
        } catch (error) {
          options.logger(
            `[browser] Late main-Chrome cleanup failed before tab preservation: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await connection.finalize(true);
      } catch (error) {
        const recoveryHandle = recoveryHandleFromError(error);
        if (recoveryHandle) {
          await noteUncertainty(
            "Open Browser Use late tab preservation failed.",
            connection,
            recoveryHandle,
          );
        }
        options.logger(
          `[browser] Late main-Chrome tab preservation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    void lateTask.catch(() => undefined);
  };
  const remove = (() => {
    if (removed) return;
    removed = true;
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
  }) as OpenBrowserUseTerminationHooks;
  remove.waitForDrain = async () => {
    await signalTask;
  };
  remove.isTerminating = () => terminating;
  remove.isLockUncertain = () => lockUncertain;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (handling) return;
    handling = true;
    terminating = true;
    options.preserveTab?.();
    options.logger(`[browser] Received ${signal}; preserving the exact main-Chrome task tab.`);
    const exitCode = signal === "SIGINT" ? 130 : 1;
    process.exitCode = exitCode;
    const deadline = Date.now() + drainTimeoutMs;
    const runWithDeadline = async <T>(task: () => Promise<T> | T, label: string): Promise<T> => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error(label);
      return withTimeout(Promise.resolve().then(task), remainingMs, label);
    };
    const task = (async () => {
      let connection: TerminationConnection | null = null;
      try {
        connection = await runWithDeadline(
          () => resolveConnection(),
          `Open Browser Use ${signal} connection resolution timed out`,
        );
        if (!connection) {
          await noteUncertainty("Open Browser Use did not return a task-tab connection.");
        } else {
          connection.requestKeepTab?.();
        }
      } catch (error) {
        await noteUncertainty(
          `Open Browser Use ${signal} connection resolution failed: ${error instanceof Error ? error.message : String(error)}`,
          connection,
          recoveryHandleFromError(error),
        );
        options.logger(
          `[browser] Failed to resolve the main-Chrome task tab before ${signal}: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!connectionSettled) scheduleLatePreservation();
      }
      if (connection && connectionSettled) {
        try {
          await runWithDeadline(
            () => runBeforeFinalize(),
            `Open Browser Use ${signal} pre-finalization cleanup timed out`,
          );
        } catch (error) {
          await noteUncertainty(
            `Open Browser Use ${signal} pre-finalization cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            connection,
          );
          options.logger(
            `[browser] Failed to clean up the main-Chrome task tab before ${signal}: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (!beforeFinalizeSettled) {
            scheduleLatePreservation();
            return;
          }
        }
        try {
          await runWithDeadline(
            () => runFinalize(connection!),
            `Open Browser Use ${signal} tab finalization timed out`,
          );
        } catch (error) {
          await noteUncertainty(
            `Open Browser Use ${signal} tab finalization failed: ${error instanceof Error ? error.message : String(error)}`,
            connection,
          );
          options.logger(
            `[browser] Failed to preserve the main-Chrome task tab during ${signal}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else if (connection && !connectionSettled) {
        scheduleLatePreservation();
      }
      if (lockUncertain) {
        await persistUncertainty();
        options.logger(
          `[browser] Retaining the main-Chrome routing lock after ${signal}; cleanup ownership is uncertain.`,
        );
        return;
      }
      try {
        await withTimeout(
          Promise.resolve().then(() => options.releaseLock()),
          Math.min(5_000, drainTimeoutMs),
          `Open Browser Use ${signal} lock release timed out`,
        );
      } catch (error) {
        await noteUncertainty(
          `Open Browser Use ${signal} lock release failed: ${error instanceof Error ? error.message : String(error)}`,
          connection,
        );
        options.logger(
          `[browser] Failed to release the main-Chrome routing lock during ${signal}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    signalTask = task.finally(() => {
      remove();
      process.exitCode = exitCode;
      const isTestRun = process.env.VITEST === "1" || process.env.NODE_ENV === "test";
      if (!isTestRun) process.exit(exitCode);
    });
  };
  for (const signal of signals) {
    const listener = () => handleSignal(signal);
    listeners.set(signal, listener);
    process.on(signal, listener);
  }
  return remove;
}

interface StoredOpenBrowserUseAffinityInput {
  runtime?: BrowserRuntimeMetadata | null;
  configs?: Array<BrowserSessionConfig | null | undefined>;
  conversationUrl?: string | null;
  conversationUrls?: Array<string | null | undefined>;
  conversationIds?: Array<string | null | undefined>;
}

export function hasStoredOpenBrowserUseAffinity(
  input: Omit<StoredOpenBrowserUseAffinityInput, "conversationUrl">,
): boolean {
  const sources = [input.runtime, ...(input.configs ?? [])].filter(
    (source): source is BrowserRuntimeMetadata | BrowserSessionConfig => Boolean(source),
  );
  return sources.some(
    (source) =>
      source.browserTransport === "obu" ||
      Boolean(source.obuSessionId?.trim()) ||
      source.obuTabId != null,
  );
}

export function resolveStoredOpenBrowserUseTabAffinity(
  input: StoredOpenBrowserUseAffinityInput,
): StoredOpenBrowserUseTabAffinity {
  const sources = [input.runtime, ...(input.configs ?? [])].filter(
    (source): source is BrowserRuntimeMetadata | BrowserSessionConfig => Boolean(source),
  );
  if (!hasStoredOpenBrowserUseAffinity(input)) {
    throw new Error("Stored browser session is not bound to Open Browser Use.");
  }
  const transports = uniqueValues(sources.map((source) => source.browserTransport).filter(Boolean));
  if (transports.some((transport) => transport !== "obu")) {
    throw new Error("Stored browser transport affinity is conflicting.");
  }

  const sessionId = singleStoredValue(
    "Open Browser Use session identity",
    sources.map((source) => source.obuSessionId),
    (value) => String(value).trim(),
  );
  const rawTabId = singleStoredValue(
    "Open Browser Use tab identity",
    sources.map((source) => source.obuTabId),
    (value) => Number(value),
  );
  const email = singleStoredValue(
    "ChatGPT account email",
    sources.map((source) => source.chatGptAccountEmail),
    (value) => String(value).trim().toLowerCase(),
  );
  const workspaceName = singleStoredValue(
    "ChatGPT workspace name",
    sources.map((source) => source.chatGptWorkspaceName),
    (value) => String(value).trim(),
  );
  const accountDigest = singleStoredValue(
    "ChatGPT account identity",
    sources.map((source) => source.chatGptAccountDigest),
    (value) => String(value).trim().toLowerCase(),
  );
  const workspaceDigest = singleStoredValue(
    "ChatGPT workspace identity",
    sources.map((source) => source.chatGptWorkspaceDigest),
    (value) => String(value).trim().toLowerCase(),
  );

  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(sessionId)) {
    throw new Error("Stored Open Browser Use session identity is invalid.");
  }
  if (!Number.isInteger(rawTabId) || rawTabId <= 0) {
    throw new Error("Stored Open Browser Use tab identity is invalid.");
  }
  if (!email || !workspaceName) {
    throw new Error("Stored main-Chrome account and workspace affinity is incomplete.");
  }
  if (!/^[a-f0-9]{64}$/.test(accountDigest) || !/^[a-f0-9]{64}$/.test(workspaceDigest)) {
    throw new Error("Stored main-Chrome account or workspace identity is invalid.");
  }

  return {
    sessionId,
    tabId: rawTabId,
    email,
    workspaceName,
    accountDigest,
    workspaceDigest,
  };
}

export function resolveStoredOpenBrowserUseAffinity(
  input: StoredOpenBrowserUseAffinityInput,
): StoredOpenBrowserUseAffinity {
  return {
    ...resolveStoredOpenBrowserUseTabAffinity(input),
    conversationUrl: resolveStoredConversationUrl(input),
  };
}

function resolveStoredConversationUrl(input: StoredOpenBrowserUseAffinityInput): string {
  const selected = input.conversationUrl?.trim() ?? "";
  if (!selected) {
    throw new Error("Stored main-Chrome conversation affinity is incomplete.");
  }
  const selectedScope = chatGptConversationScopeFromUrl(selected);
  if (!selectedScope) {
    throw new Error("Stored main-Chrome conversation affinity is invalid.");
  }
  const urlCandidates = [
    selected,
    ...(input.conversationUrls ?? []),
    input.runtime?.tabUrl,
    ...(input.configs ?? []).flatMap((config) => [
      config?.resumeConversationUrl,
      config?.chatgptUrl,
      config?.url,
    ]),
  ];
  for (const raw of urlCandidates) {
    const candidate = raw?.trim();
    if (!candidate) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error("Stored main-Chrome conversation affinity is invalid.");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "chatgpt.com" ||
      Boolean(parsed.port) ||
      Boolean(parsed.username || parsed.password) ||
      parsed.pathname.includes("%")
    ) {
      throw new Error("Stored main-Chrome conversation affinity is invalid.");
    }
    const scope = chatGptConversationScopeFromUrl(candidate);
    if (!scope) {
      if (parsed.pathname.includes("/c/")) {
        throw new Error("Stored main-Chrome conversation affinity is invalid.");
      }
      continue;
    }
    if (!isSameChatGptConversationScope(candidate, selected)) {
      throw new Error("Stored main-Chrome conversation affinity is conflicting.");
    }
  }
  for (const raw of [input.runtime?.conversationId, ...(input.conversationIds ?? [])]) {
    const conversationId = raw?.trim();
    if (!conversationId) continue;
    if (!/^[a-zA-Z0-9-]+$/.test(conversationId)) {
      throw new Error("Stored main-Chrome conversation affinity is invalid.");
    }
    if (conversationId !== selectedScope.conversationId) {
      throw new Error("Stored main-Chrome conversation affinity is conflicting.");
    }
  }
  return new URL(selected).href;
}

function singleStoredValue<T>(
  label: string,
  rawValues: Array<unknown>,
  normalize: (value: unknown) => T,
): T {
  const values = uniqueValues(
    rawValues
      .filter((value) => value !== undefined && value !== null && value !== "")
      .map(normalize),
  );
  if (values.length === 0) throw new Error(`Stored ${label} is incomplete.`);
  if (values.length > 1) throw new Error(`Stored ${label} is conflicting.`);
  return values[0] as T;
}

function uniqueValues<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export async function verifyOpenBrowserUseBridge(
  options: {
    timeoutMs?: number;
    socketPath?: string;
    clientFactory?: (options: {
      socketPath: string;
      sessionId: string;
      timeoutMs: number;
    }) => OpenBrowserUseClientLike;
  } = {},
): Promise<{ socketPath: string }> {
  const socketPath = options.socketPath ?? (await resolveOpenBrowserUseSocketPath());
  const sessionId = `oracle-preflight-${randomUUID()}`;
  const timeoutMs = Math.max(5_000, options.timeoutMs ?? 30_000);
  const client = options.clientFactory
    ? options.clientFactory({ socketPath, sessionId, timeoutMs })
    : new OpenBrowserUseClient({ socketPath, sessionId, turnId: sessionId, timeoutMs });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    assertCompatibleOpenBrowserUseInfo(await client.getInfo());
    return { socketPath };
  } finally {
    try {
      if (connected) await client.finalizeTabs([]);
    } finally {
      client.close();
    }
  }
}

function assertCompatibleOpenBrowserUseInfo(info: JsonValue): void {
  const version =
    info && typeof info === "object" && !Array.isArray(info) && typeof info.version === "string"
      ? info.version.trim()
      : "";
  if (version === REQUIRED_OPEN_BROWSER_USE_VERSION) return;
  throw new BrowserAutomationError(
    `Oracle requires Open Browser Use extension ${REQUIRED_OPEN_BROWSER_USE_VERSION}; main Chrome reported ${version || "an unknown version"}. Ask Paul before upgrading or re-registering the native host.`,
    {
      stage: "open-browser-use",
      code: "extension-version-mismatch",
      expectedVersion: REQUIRED_OPEN_BROWSER_USE_VERSION,
      actualVersion: version || null,
    },
  );
}

export function isAllowedOpenBrowserUseConsultUrl(candidate: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "chatgpt.com" ||
    Boolean(parsed.port) ||
    Boolean(parsed.username || parsed.password) ||
    parsed.pathname.includes("%") ||
    Boolean(parsed.hash)
  ) {
    return false;
  }
  if (parsed.pathname === "/") {
    if (!parsed.search) return true;
    return (
      parsed.searchParams.size === 1 &&
      parsed.searchParams.get("temporary-chat")?.toLowerCase() === "true"
    );
  }
  return /^\/g\/[a-zA-Z0-9-]+\/project$/u.test(parsed.pathname) && !parsed.search;
}

export async function prepareOpenBrowserUseChatGptRoute(options: {
  connection: OpenBrowserUseConnection;
  expectation: ChatGptIdentityExpectation;
  targetUrl: string;
  logger: BrowserLogger;
}): Promise<ChatGptIdentityEvidence> {
  if (!isAllowedOpenBrowserUseConsultUrl(options.targetUrl)) {
    throw new BrowserAutomationError(
      "Open Browser Use accepts only the ChatGPT root, temporary-chat root, or a canonical project shell for a new consult.",
      {
        stage: "open-browser-use",
        code: "chatgpt-origin-mismatch",
      },
    );
  }
  const target = new URL(options.targetUrl);
  const { Input, Page, Runtime } = options.connection.client;
  await navigateToChatGPT(Page, Runtime, "https://chatgpt.com/", options.logger);
  await ensureNotBlocked(Runtime, false, options.logger);
  const evidence = await ensureChatGptIdentity(Runtime, Input, options.expectation, options.logger);
  await navigateToChatGPT(Page, Runtime, target.href, options.logger);
  await ensureNotBlocked(Runtime, false, options.logger);
  await ensureChatGptScopeRetained(Runtime, target.href);
  await assertChatGptIdentity(Runtime, evidence);
  return evidence;
}

export function isAllowedOpenBrowserUseConversationUrl(candidate: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  return Boolean(
    parsed.protocol === "https:" &&
    parsed.hostname === "chatgpt.com" &&
    !parsed.port &&
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash &&
    !parsed.pathname.includes("%") &&
    /^\/(?:g\/[a-zA-Z0-9-]+\/)?c\/[a-zA-Z0-9-]+$/u.test(parsed.pathname),
  );
}

export async function prepareOpenBrowserUseConversationRoute(options: {
  connection: OpenBrowserUseConnection;
  expectation: ChatGptIdentityExpectation;
  targetUrl: string;
  logger: BrowserLogger;
}): Promise<ChatGptIdentityEvidence> {
  if (!isAllowedOpenBrowserUseConversationUrl(options.targetUrl)) {
    throw new BrowserAutomationError("Stored main-Chrome conversation affinity is invalid.", {
      stage: "open-browser-use",
      code: "conversation-affinity-invalid",
    });
  }
  const { Input, Page, Runtime } = options.connection.client;
  await navigateToChatGPT(Page, Runtime, "https://chatgpt.com/", options.logger);
  await ensureNotBlocked(Runtime, false, options.logger);
  const evidence = await ensureChatGptIdentity(Runtime, Input, options.expectation, options.logger);
  await navigateToChatGPT(Page, Runtime, options.targetUrl, options.logger);
  await ensureNotBlocked(Runtime, false, options.logger);
  await ensureChatGptScopeRetained(Runtime, options.targetUrl);
  await assertChatGptIdentity(Runtime, evidence);
  return evidence;
}

export async function waitForOpenBrowserUseConversationUrl(options: {
  connection: OpenBrowserUseConnection;
  timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  do {
    const { result } = await options.connection.client.Runtime.evaluate({
      expression: "location.href",
      returnByValue: true,
    });
    const candidate = typeof result?.value === "string" ? result.value : "";
    if (isAllowedOpenBrowserUseConversationUrl(candidate)) return new URL(candidate).href;
    if (candidate) {
      try {
        if (new URL(candidate).hostname !== "chatgpt.com") {
          throw new BrowserAutomationError("Main Chrome left the trusted ChatGPT origin.", {
            stage: "main-chrome-account-router",
            code: "chatgpt-origin-mismatch",
          });
        }
      } catch (error) {
        if (error instanceof BrowserAutomationError) throw error;
      }
    }
    await delay(250);
  } while (Date.now() < deadline);
  throw new BrowserAutomationError(
    "The exact main-Chrome task tab did not expose a stable ChatGPT conversation URL.",
    { stage: "chatgpt-scope", code: "conversation-affinity-unavailable" },
  );
}

async function isUnixSocketReachable(socketPath: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

export async function resolveOpenBrowserUseSocketPath(
  registryPath = ACTIVE_REGISTRY_PATH,
): Promise<string> {
  try {
    const runtimeDir = path.dirname(registryPath);
    const runtimeDirStat = await lstat(runtimeDir);
    if (!runtimeDirStat.isDirectory() || runtimeDirStat.isSymbolicLink()) {
      throw new Error("runtime path is not a regular directory");
    }
    assertPrivateRuntimePath(runtimeDirStat, "runtime directory");
    const registryStat = await lstat(registryPath);
    if (!registryStat.isFile() || registryStat.isSymbolicLink()) {
      throw new Error("active registry is not a regular file");
    }
    assertPrivateRuntimePath(registryStat, "active registry");
    const record = JSON.parse(await readFile(registryPath, "utf8")) as ActiveSocketRecord;
    const socketPath = typeof record.socketPath === "string" ? record.socketPath.trim() : "";
    const pid = typeof record.pid === "number" ? record.pid : Number.NaN;
    if (!socketPath || !path.isAbsolute(socketPath)) {
      throw new Error("active registry has no absolute socketPath");
    }
    const expectedRoot = path.resolve(
      registryPath === ACTIVE_REGISTRY_PATH ? ACTIVE_SOCKET_ROOT : runtimeDir,
    );
    const resolvedSocket = path.resolve(socketPath);
    if (
      resolvedSocket !== expectedRoot &&
      !resolvedSocket.startsWith(`${expectedRoot}${path.sep}`)
    ) {
      throw new Error("active socket is outside the Open Browser Use runtime directory");
    }
    const socketStat = await lstat(resolvedSocket);
    if (!socketStat.isSocket() || socketStat.isSymbolicLink()) {
      throw new Error("active socket is not a Unix socket");
    }
    assertPrivateRuntimePath(socketStat, "active socket");
    if (pid === 0) {
      if (!(await isUnixSocketReachable(resolvedSocket))) {
        throw new Error("active native-host socket is not reachable");
      }
    } else if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
      throw new Error("active native-host process is not running");
    }
    return resolvedSocket;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BrowserAutomationError(
      `Open Browser Use is not connected to the main Chrome profile (${message}). Run “open-browser-use ping” and “open-browser-use info”; if setup is missing, ask Paul before installing or registering the native host.`,
      { stage: "open-browser-use", code: "browser-unavailable" },
      error,
    );
  }
}

export async function acquireOpenBrowserUseRunLock(options: {
  timeoutMs: number;
  logger: BrowserLogger;
  sessionId?: string;
  registryPath?: string;
}): Promise<ProfileRunLock> {
  const socketPath = await resolveOpenBrowserUseSocketPath(options.registryPath);
  const lockRoot = path.join(path.dirname(socketPath), "oracle-main-chrome");
  const lock = await acquireProfileRunLock(lockRoot, {
    timeoutMs: options.timeoutMs,
    logger: options.logger,
    sessionId: options.sessionId,
    reclaimDeadOwner: false,
  });
  if (!lock) {
    throw new BrowserAutomationError("Main Chrome account routing lock is disabled.", {
      stage: "open-browser-use",
      code: "browser-lock-disabled",
    });
  }
  return lock;
}

export async function connectOpenBrowserUseTab(options: {
  oracleSessionId?: string;
  obuSessionId?: string | null;
  obuTabId?: number | null;
  exactTabOnly?: boolean;
  conversationUrl?: string | null;
  timeoutMs?: number;
  logger: BrowserLogger;
  socketPath?: string;
  clientFactory?: (options: {
    socketPath: string;
    sessionId: string;
    timeoutMs: number;
  }) => OpenBrowserUseClientLike;
}): Promise<OpenBrowserUseConnection> {
  const socketPath = options.socketPath ?? (await resolveOpenBrowserUseSocketPath());
  const requestedSessionId = options.obuSessionId?.trim() || null;
  let sessionId = requestedSessionId || `oracle-${options.oracleSessionId?.trim() || randomUUID()}`;
  assertOpenBrowserUseSessionId(sessionId);
  const timeoutMs = Math.max(30_000, options.timeoutMs ?? 120_000);
  const createClient = (id: string): OpenBrowserUseClientLike =>
    options.clientFactory
      ? options.clientFactory({ socketPath, sessionId: id, timeoutMs })
      : new OpenBrowserUseClient({
          socketPath,
          sessionId: id,
          turnId: `oracle-${Date.now()}`,
          timeoutMs,
        });
  const initializeClient = async (
    client: OpenBrowserUseClientLike,
    id: string,
  ): Promise<ObuTab[]> => {
    await client.connect();
    assertCompatibleOpenBrowserUseInfo(await client.getInfo());
    await client.nameSession(`Oracle ${options.oracleSessionId ?? id}`);
    return parseTabs(await client.getTabs());
  };

  let obuClient = createClient(sessionId);
  let tab: ObuTab | undefined;
  let created = false;
  try {
    const tabs = await initializeClient(obuClient, sessionId);
    const expectedConversationScope = options.conversationUrl
      ? chatGptConversationScopeFromUrl(options.conversationUrl)
      : undefined;
    if (options.conversationUrl && !expectedConversationScope) {
      throw new BrowserAutomationError("Stored main-Chrome conversation affinity is invalid.", {
        stage: "open-browser-use",
        code: "conversation-affinity-invalid",
      });
    }
    tab = options.obuTabId
      ? tabs.find((candidate) => candidate.id === options.obuTabId)
      : undefined;
    if (options.exactTabOnly && options.obuTabId && !tab) {
      throw new BrowserAutomationError("Stored Open Browser Use recovery tab is unavailable.", {
        stage: "open-browser-use",
        code: "tab-affinity-missing",
      });
    }
    if (
      tab &&
      options.conversationUrl &&
      (!chatGptConversationScopeFromUrl(tab.url ?? "") ||
        !isSameChatGptConversationScope(tab.url ?? "", options.conversationUrl))
    ) {
      throw new BrowserAutomationError(
        "Stored Open Browser Use tab no longer points to the expected ChatGPT conversation.",
        { stage: "open-browser-use", code: "tab-affinity-mismatch" },
      );
    }
    if (!options.exactTabOnly && !tab && requestedSessionId && options.obuTabId) {
      obuClient.close();
      sessionId = buildRecoveryOpenBrowserUseSessionId(options.oracleSessionId);
      obuClient = createClient(sessionId);
      await initializeClient(obuClient, sessionId);
      options.logger(
        `[browser] Stored main-Chrome tab was unavailable; recovering in a fresh OBU session (${sessionId})`,
      );
    }
    if (!tab) {
      tab = parseTab(await obuClient.createTab(), "createTab response");
      created = true;
      options.logger(`[browser] Opened main-Chrome Oracle tab (obu=${sessionId}:${tab.id})`);
    } else {
      options.logger(`[browser] Reclaimed main-Chrome Oracle tab (obu=${sessionId}:${tab.id})`);
    }
    await obuClient.attach(tab.id);
    const attachedTab = tab;

    const adapter = createOpenBrowserUseChromeClient(obuClient, attachedTab.id);
    let keepRequested = false;
    let finalizePromise: Promise<void> | null = null;
    let finalizationStarted = false;
    let finalizationKeepTab = false;
    let finalizationCompleted = false;
    let lateKeepRequested = false;
    const lateTabPreservationError = () =>
      new BrowserAutomationError(
        "A termination signal arrived after the main-Chrome tab handoff committed; the exact task tab could not be verified for reattach.",
        {
          stage: "open-browser-use",
          code: "late-tab-preservation-race",
          recoveryHandle: {
            transport: "obu",
            sessionId,
            tabId: attachedTab.id,
            conversationUrl: options.conversationUrl ?? attachedTab.url ?? null,
          },
        },
      );
    const requestKeepTab = () => {
      if (finalizationStarted && !finalizationKeepTab) lateKeepRequested = true;
      keepRequested = true;
    };
    const finalize = (keepTab: boolean): Promise<void> => {
      if (keepTab) requestKeepTab();
      if (keepTab && finalizationCompleted && !finalizationKeepTab) {
        return Promise.reject(lateTabPreservationError());
      }
      finalizePromise ??= (async () => {
        let finalizeFailure: unknown;
        try {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const liveTabs = parseTabs(await obuClient.getTabs());
              await obuClient.turnEnded().catch(() => undefined);
              const shouldKeepTab = keepRequested;
              if (shouldKeepTab && !liveTabs.some((candidate) => candidate.id === attachedTab.id)) {
                throw new Error("Open Browser Use task tab is missing from the live tab inventory");
              }
              const keep = liveTabs
                .filter((candidate) => candidate.id !== attachedTab.id || shouldKeepTab)
                .map((candidate) => ({ tabId: candidate.id, status: "handoff" }) as JsonValue);
              finalizationStarted = true;
              finalizationKeepTab = shouldKeepTab;
              await obuClient.finalizeTabs(keep);
              if (lateKeepRequested && !shouldKeepTab) {
                const after = parseTabs(await obuClient.getTabs());
                if (!after.some((candidate) => candidate.id === attachedTab.id)) {
                  throw lateTabPreservationError();
                }
                finalizationKeepTab = true;
              }
              finalizationCompleted = true;
              return;
            } catch (error) {
              if (
                error instanceof BrowserAutomationError &&
                error.details?.code === "late-tab-preservation-race"
              ) {
                throw error;
              }
              finalizeFailure = error;
            }
          }
          throw new BrowserAutomationError(
            "Failed to finalize the task-owned main-Chrome Oracle tab.",
            {
              stage: "open-browser-use",
              code: "tab-finalize-failed",
              recoveryHandle: {
                transport: "obu",
                sessionId,
                tabId: attachedTab.id,
                conversationUrl: options.conversationUrl ?? attachedTab.url ?? null,
              },
            },
            finalizeFailure,
          );
        } finally {
          await adapter.close().catch(() => undefined);
          obuClient.close();
        }
      })();
      return finalizePromise;
    };
    return {
      client: adapter,
      obuClient,
      sessionId,
      tabId: attachedTab.id,
      tabUrl: attachedTab.url,
      created,
      finalize,
      requestKeepTab,
    };
  } catch (error) {
    let cleanupFailed = false;
    if (created && tab) {
      try {
        const liveTabs = parseTabs(await obuClient.getTabs());
        const keep = liveTabs
          .filter((candidate) => candidate.id !== tab?.id)
          .map((candidate) => ({ tabId: candidate.id, status: "handoff" }) as JsonValue);
        await obuClient.turnEnded().catch(() => undefined);
        await obuClient.finalizeTabs(keep);
      } catch {
        cleanupFailed = true;
      }
    }
    obuClient.close();
    if (cleanupFailed && tab) {
      const details = error instanceof BrowserAutomationError ? error.details : undefined;
      throw new BrowserAutomationError(
        error instanceof Error ? error.message : String(error),
        {
          ...details,
          stage: details?.stage ?? "open-browser-use",
          recoveryHandle: {
            transport: "obu",
            sessionId,
            tabId: tab.id,
            conversationUrl: options.conversationUrl ?? tab.url ?? null,
          },
        },
        error,
      );
    }
    throw error;
  }
}

function assertOpenBrowserUseSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(sessionId)) {
    throw new BrowserAutomationError("Stored Open Browser Use session identity is invalid.", {
      stage: "open-browser-use",
      code: "session-identity-invalid",
    });
  }
}

function buildRecoveryOpenBrowserUseSessionId(oracleSessionId: string | undefined): string {
  const label = oracleSessionId?.trim();
  const prefix = label && /^[a-zA-Z0-9._:-]+$/.test(label) ? `oracle-${label}` : "oracle-recovery";
  const sessionId = `${prefix.slice(0, 110)}-${randomUUID()}`;
  assertOpenBrowserUseSessionId(sessionId);
  return sessionId;
}

const BLOCKED_OPEN_BROWSER_USE_CDP_METHODS = new Set([
  "Network.getCookies",
  "Network.getAllCookies",
  "Storage.getCookies",
]);

const SENSITIVE_OPEN_BROWSER_USE_CDP_KEYS = new Set([
  "authorization",
  "cookie",
  "cookies",
  "headerstext",
  "proxy-authorization",
  "requestheaderstext",
  "set-cookie",
  "setcookie",
]);

function sanitizeOpenBrowserUseCdpValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeOpenBrowserUseCdpValue(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_OPEN_BROWSER_USE_CDP_KEYS.has(key.toLowerCase())
        ? "[redacted]"
        : sanitizeOpenBrowserUseCdpValue(nested),
    ]),
  );
}

export function createOpenBrowserUseChromeClient(
  obuClient: OpenBrowserUseClientLike,
  tabId: number,
): ChromeClient {
  const events = new EventEmitter();
  let disconnected = false;
  const notifyDisconnect = () => {
    if (!disconnected) {
      disconnected = true;
      events.emit("disconnect");
    }
  };
  const unsubscribe = obuClient.onNotification((notification) => {
    if (notification.method !== "onCDPEvent" || !isRecord(notification.params)) return;
    const source = notification.params.source;
    if (!isRecord(source) || source.tabId !== tabId) return;
    const method = notification.params.method;
    if (typeof method !== "string") return;
    const params = notification.params.params;
    const eventParams = isRecord(params)
      ? (sanitizeOpenBrowserUseCdpValue(params) as Record<string, unknown>)
      : {};
    const sourceSessionId = typeof source.sessionId === "string" ? source.sessionId : undefined;
    events.emit(method, eventParams, sourceSessionId);
    if (sourceSessionId) {
      events.emit(`${method}.${sourceSessionId}`, eventParams, sourceSessionId);
    }
  });
  const send = async (
    method: string,
    commandParams: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> => {
    if (BLOCKED_OPEN_BROWSER_USE_CDP_METHODS.has(method)) {
      throw new BrowserAutomationError(
        "Open Browser Use refused a CDP cookie-extraction method; authenticated data must stay in the browser context.",
        { stage: "open-browser-use", code: "cookie-extraction-blocked" },
      );
    }
    try {
      const response = await obuClient.request("executeCdp", {
        target: {
          tabId,
          ...(sessionId ? { sessionId } : {}),
        },
        method,
        commandParams: commandParams as BrowserUseRequestParams,
      });
      return sanitizeOpenBrowserUseCdpValue(response);
    } catch (error) {
      if (/socket closed|not connected|econnreset|broken pipe/i.test(String(error))) {
        notifyDisconnect();
      }
      throw error;
    }
  };
  const bindDomain = (domainName: string) =>
    new Proxy(
      {},
      {
        get(_target, property) {
          const name = String(property);
          if (name === "on") {
            return (event: string, listener: (...args: unknown[]) => void) => {
              events.on(`${domainName}.${event}`, listener);
              return () => events.off(`${domainName}.${event}`, listener);
            };
          }
          if (name === "off" || name === "removeListener") {
            return (event: string, listener: (...args: unknown[]) => void) => {
              events.off(`${domainName}.${event}`, listener);
            };
          }
          return (params: Record<string, unknown> = {}) => send(`${domainName}.${name}`, params);
        },
      },
    );

  const client = {
    Network: bindDomain("Network"),
    Page: bindDomain("Page"),
    Runtime: bindDomain("Runtime"),
    Input: bindDomain("Input"),
    DOM: bindDomain("DOM"),
    Emulation: bindDomain("Emulation"),
    Target: bindDomain("Target"),
    send,
    on: events.on.bind(events),
    once: events.once.bind(events),
    off: events.off.bind(events),
    removeListener: events.removeListener.bind(events),
    close: async () => {
      unsubscribe();
      events.removeAllListeners();
    },
  };
  return client as unknown as ChromeClient;
}

function assertPrivateRuntimePath(stat: { uid: number; mode: number }, label: string): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} is owned by another user`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} is accessible to another user`);
  }
}

function parseTabs(value: JsonValue): ObuTab[] {
  if (!Array.isArray(value)) {
    throw new Error("getTabs response did not include a tab array");
  }
  const tabs = value.map((candidate) => parseTab(candidate, "getTabs response"));
  const ids = new Set<number>();
  for (const tab of tabs) {
    if (ids.has(tab.id)) {
      throw new Error("getTabs response included a duplicate tab id");
    }
    ids.add(tab.id);
  }
  return tabs;
}

function parseTab(value: JsonValue, label: string): ObuTab {
  if (!isRecord(value)) {
    throw new Error(`${label} did not include a tab object`);
  }
  const rawId = value.id;
  const id = typeof rawId === "number" ? rawId : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${label} did not include a numeric tab id`);
  }
  if (value.url !== undefined && typeof value.url !== "string") {
    throw new Error(`${label} included an invalid tab URL`);
  }
  if (value.title !== undefined && typeof value.title !== "string") {
    throw new Error(`${label} included an invalid tab title`);
  }
  return {
    id,
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const __test__ = {
  ACTIVE_REGISTRY_PATH,
  ACTIVE_SOCKET_ROOT,
  parseTabs,
};
