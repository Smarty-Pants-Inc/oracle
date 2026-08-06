import CDP from "chrome-remote-interface";
import type { BrowserLogger, ChromeClient } from "./types.js";
import {
  discoverBrowserWebSocketEndpoint,
  type ExactChromeEndpointOperationResult,
  type RetainedChromeEndpointAuthority,
} from "./chromeEndpointAuthority.js";
import { delay } from "./utils.js";

export async function connectToChrome(
  port: number,
  logger: BrowserLogger,
  host?: string,
): Promise<ChromeClient> {
  const client = await CDP({ port, host });
  logger("Connected to Chrome DevTools protocol");
  return client;
}

class ExactTargetCleanupUnconfirmedError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ExactTargetCleanupUnconfirmedError";
  }
}

export async function connectToRemoteChrome(
  host: string,
  port: number,
  logger: BrowserLogger,
  targetUrl?: string,
  browserWSEndpoint?: string,
  options?: {
    approvalWaitMs?: number;
  },
): Promise<RemoteChromeConnection> {
  if (browserWSEndpoint) {
    return await connectToRemoteChromeTarget(host, port, logger, {
      browserWSEndpoint,
      targetUrl: targetUrl ?? "about:blank",
      closeTargetOnDispose: false,
      approvalWaitMs: options?.approvalWaitMs,
    });
  }
  if (targetUrl) {
    try {
      return await connectWithNewTabWithRetainedLiveAuthority(port, logger, targetUrl, host);
    } catch (error) {
      if (error instanceof ExactTargetCleanupUnconfirmedError) throw error;
      logger(
        `Failed to open dedicated remote Chrome tab with retained live authority (${error instanceof Error ? error.message : String(error)}); falling back to an existing page target.`,
      );
    }
  }
  const targets = await listRemoteChromeTargets({ host, port });
  const fallbackTarget = targets.find((target) => target.type === "page" && target.targetId);
  if (!fallbackTarget?.targetId) {
    throw new Error(`No attachable remote Chrome page target is available at ${host}:${port}.`);
  }
  logger(`Attached to existing remote Chrome tab ${fallbackTarget.targetId}`);
  return await connectToRemoteChromeTarget(host, port, logger, {
    targetId: fallbackTarget.targetId,
  });
}

export type RemoteTargetOwnership = "created" | "attached";
function shouldCloseTargetOnDispose(
  ownership: RemoteTargetOwnership,
  requested: boolean | undefined,
): boolean {
  return ownership === "created" && requested === true;
}

export interface RetainedLiveChromeTargetAuthority {
  runExactOperation<T>(
    operation: (client: ChromeClient) => Promise<T>,
  ): Promise<ExactChromeEndpointOperationResult<T>>;
  release(): Promise<void>;
}
export type ExactChromeTargetOperationAuthority = Pick<
  RetainedChromeEndpointAuthority,
  "runExactOperation"
>;

export interface RemoteChromeConnection {
  client: ChromeClient;
  targetId: string;
  ownership: RemoteTargetOwnership;
  targetCloseAuthority?: RetainedLiveChromeTargetAuthority;
  browserWSEndpoint?: string;
  close: () => Promise<void>;
}

export interface IsolatedTabConnection {
  client: ChromeClient;
  targetId?: string;
  targetCloseAuthority?: RetainedLiveChromeTargetAuthority;
}

interface TargetConnectMessages {
  opened?: (targetId: string) => string;
  openFailed: (message: string) => string;
  attachFailed: (targetId: string, message: string) => string;
  closeFailed: (targetId: string, message: string) => string;
}

export interface RemoteTargetInfo {
  targetId?: string;
  type?: string;
  title?: string;
  url?: string;
}

interface ChromeTargetOperations {
  list(): Promise<RemoteTargetInfo[]>;
  create(url: string): Promise<string>;
  attach(targetId: string): Promise<ChromeClient>;
  close(targetId: string): Promise<boolean>;
}

class ExactTargetOperationFailure extends Error {
  constructor(
    readonly result: Exclude<ExactChromeEndpointOperationResult<never>, { status: "completed" }>,
  ) {
    super(result.status === "gone" ? "Exact Chrome process generation exited" : result.reason);
    this.name = "ExactTargetOperationFailure";
  }
}

class TargetOpenFailure extends Error {
  constructor(
    readonly stage: "create" | "attach",
    readonly targetId: string | undefined,
    readonly cause: unknown,
    readonly cleanupError?: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TargetOpenFailure";
  }
}

function findExactTargetOperationFailure(error: unknown): ExactTargetOperationFailure | undefined {
  if (error instanceof ExactTargetOperationFailure) return error;
  if (!(error instanceof TargetOpenFailure)) return undefined;
  if (error.cause instanceof ExactTargetOperationFailure) return error.cause;
  return error.cleanupError instanceof ExactTargetOperationFailure ? error.cleanupError : undefined;
}

export async function listRemoteChromeTargets(options: {
  host: string;
  port: number;
  browserWSEndpoint?: string;
}): Promise<RemoteTargetInfo[]> {
  if (!options.browserWSEndpoint) {
    return await rawChromeTargetOperations(options.host, options.port).list();
  }
  const browser = await CDP({ target: options.browserWSEndpoint, local: true });
  try {
    return await browserChromeTargetOperations(browser).list();
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function connectToRemoteChromeTarget(
  host: string,
  port: number,
  logger: BrowserLogger,
  options: {
    targetId?: string;
    targetUrl?: string;
    browserWSEndpoint?: string;
    closeTargetOnDispose?: boolean;
    approvalWaitMs?: number;
  },
): Promise<RemoteChromeConnection> {
  if (!options.browserWSEndpoint) {
    if (!options.targetId) {
      throw new Error("A target id is required to attach to remote Chrome over HTTP.");
    }
    const client = await rawChromeTargetOperations(host, port).attach(options.targetId);
    return {
      client,
      targetId: options.targetId,
      ownership: "attached",
      close: async () => {
        await client.close().catch(() => undefined);
      },
    };
  }

  const browser = await connectToBrowserWebSocket(
    host,
    port,
    options.browserWSEndpoint,
    logger,
    options.approvalWaitMs,
  );
  const operations = browserChromeTargetOperations(browser);
  const ownership: RemoteTargetOwnership = options.targetId ? "attached" : "created";
  let targetId = options.targetId;
  let client: ChromeClient | undefined;
  let browserReleased = false;
  let closeTargetOnRelease = shouldCloseTargetOnDispose(ownership, options.closeTargetOnDispose);
  const releaseBrowser = async (): Promise<void> => {
    if (browserReleased) return;
    await client?.close().catch(() => undefined);
    if (closeTargetOnRelease && targetId) {
      if (!(await operations.close(targetId))) {
        throw new Error(`Chrome rejected target close for ${targetId}`);
      }
      closeTargetOnRelease = false;
    }
    await browser.close();
    browserReleased = true;
  };
  const targetCloseAuthority: RetainedLiveChromeTargetAuthority = {
    runExactOperation: async (operation) => {
      if (browserReleased) {
        return {
          status: "unsafe",
          reason: "Retained live Chrome target authority has already been released",
        };
      }
      try {
        return { status: "completed", value: await operation(browser) };
      } catch (error) {
        return {
          status: "unsafe",
          reason: `Retained live Chrome target operation failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    release: releaseBrowser,
  };
  try {
    if (targetId) {
      client = await operations.attach(targetId);
    } else {
      const connection = await openChromeTarget(operations, options.targetUrl ?? "about:blank");
      targetId = connection.targetId;
      client = connection.client;
      logger(`Opened dedicated remote Chrome tab targeting ${options.targetUrl ?? "about:blank"}`);
    }
    return {
      client: client as ChromeClient,
      targetId: targetId as string,
      browserWSEndpoint: options.browserWSEndpoint,
      ownership,
      targetCloseAuthority,
      close: releaseBrowser,
    };
  } catch (error) {
    await releaseBrowser().catch(() => undefined);
    if (error instanceof TargetOpenFailure && error.cleanupError) {
      const message =
        error.cleanupError instanceof Error
          ? error.cleanupError.message
          : String(error.cleanupError);
      logger(`Failed to close unused remote Chrome tab ${error.targetId}: ${message}`);
      throw new ExactTargetCleanupUnconfirmedError(
        `Remote Chrome target acquisition failed and cleanup was not confirmed for ${error.targetId}`,
        new AggregateError(
          [error.cause, error.cleanupError],
          "Remote target acquisition and cleanup failed",
        ),
      );
    }
    throw error instanceof TargetOpenFailure ? error.cause : error;
  }
}

async function connectToBrowserWebSocket(
  host: string,
  port: number,
  browserWSEndpoint: string,
  logger: BrowserLogger,
  approvalWaitMs?: number,
): Promise<ChromeClient> {
  if (!approvalWaitMs || approvalWaitMs <= 0) {
    return (await CDP({ target: browserWSEndpoint, local: true })) as ChromeClient;
  }

  logger(`Waiting for Chrome remote debugging approval for ${host}:${port}...`);

  const deadline = Date.now() + approvalWaitMs;
  let lastApprovalError: unknown;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    try {
      return await Promise.race([
        CDP({ target: browserWSEndpoint, local: true }) as Promise<ChromeClient>,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("__oracle_remote_debugging_approval_timeout__"));
          }, remainingMs);
        }),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "__oracle_remote_debugging_approval_timeout__"
      ) {
        break;
      }
      if (!isRemoteDebuggingApprovalError(error)) {
        throw error;
      }
      lastApprovalError = error;
      await delay(Math.min(500, Math.max(0, deadline - Date.now())));
    }
  }
  const suffix =
    lastApprovalError instanceof Error && lastApprovalError.message
      ? ` Last Chrome response: ${lastApprovalError.message}`
      : "";
  throw new Error(
    `Oracle waited ${formatApprovalWait(approvalWaitMs)} for Chrome remote debugging approval at ${host}:${port}. Allow the Chrome prompt or retry after toggling remote debugging.${suffix}`,
  );
}

function isRemoteDebuggingApprovalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unexpected server response:\s*403|remote debugging|forbidden/i.test(message);
}

function formatApprovalWait(waitMs: number): string {
  if (waitMs % 1000 === 0) {
    return `${waitMs / 1000}s`;
  }
  return `${waitMs}ms`;
}

const CLOSE_CONFIRM_ATTEMPTS = 40;
const CLOSE_CONFIRM_DELAY_MS = 25;

function mapRemoteTarget(target: {
  id?: string;
  targetId?: string;
  type?: string;
  title?: string;
  url?: string;
}): RemoteTargetInfo {
  return {
    targetId: target.targetId ?? target.id,
    type: target.type,
    title: target.title,
    url: target.url,
  };
}

function rawChromeTargetOperations(host: string, port: number): ChromeTargetOperations {
  return {
    list: async () =>
      (
        (await CDP.List({ host, port })) as Array<{
          id?: string;
          targetId?: string;
          type?: string;
          title?: string;
          url?: string;
        }>
      ).map(mapRemoteTarget),
    create: async (url) => {
      const created = (await CDP.New({ host, port, url })) as { id?: string; targetId?: string };
      const targetId = created.targetId ?? created.id;
      if (!targetId) throw new Error("Chrome target creation returned no target id");
      return targetId;
    },
    attach: async (targetId) => await CDP({ host, port, target: targetId }),
    close: async (targetId) => {
      await CDP.Close({ host, port, id: targetId });
      return true;
    },
  };
}

function browserChromeTargetOperations(browser: ChromeClient): ChromeTargetOperations {
  return {
    list: async () => ((await browser.Target.getTargets()).targetInfos ?? []).map(mapRemoteTarget),
    create: async (url) => {
      const created = await browser.Target.createTarget({ url });
      if (!created.targetId) throw new Error("Chrome target creation returned no target id");
      return created.targetId;
    },
    attach: async (targetId) => {
      const attached = await browser.Target.attachToTarget({ targetId, flatten: true });
      return createSessionBoundChromeClient(browser, attached.sessionId);
    },
    close: async (targetId) => (await browser.Target.closeTarget({ targetId })).success !== false,
  };
}

async function openChromeTarget(
  operations: ChromeTargetOperations,
  url: string,
): Promise<{ client: ChromeClient; targetId: string }> {
  let targetId: string;
  try {
    targetId = await operations.create(url);
  } catch (error) {
    throw new TargetOpenFailure("create", undefined, error);
  }
  try {
    return { client: await operations.attach(targetId), targetId };
  } catch (error) {
    try {
      if (!(await operations.close(targetId))) {
        throw new Error(`Chrome rejected cleanup of unused target ${targetId}`);
      }
    } catch (cleanupError) {
      throw new TargetOpenFailure("attach", targetId, error, cleanupError);
    }
    throw new TargetOpenFailure("attach", targetId, error);
  }
}

function describeTargetOpenFailure(error: unknown, messages: TargetConnectMessages): string[] {
  if (!(error instanceof TargetOpenFailure)) {
    return [messages.openFailed(error instanceof Error ? error.message : String(error))];
  }
  const message = error.cause instanceof Error ? error.cause.message : String(error.cause);
  const lines =
    error.stage === "create" || !error.targetId
      ? [messages.openFailed(message)]
      : [messages.attachFailed(error.targetId, message)];
  if (error.cleanupError && error.targetId) {
    lines.push(
      messages.closeFailed(
        error.targetId,
        error.cleanupError instanceof Error
          ? error.cleanupError.message
          : String(error.cleanupError),
      ),
    );
  }
  return lines;
}

async function connectToNewTarget(
  operations: ChromeTargetOperations,
  url: string,
  logger: BrowserLogger,
  messages: TargetConnectMessages,
  options?: { retries?: number; retryDelayMs?: number },
): Promise<{ client: ChromeClient; targetId: string }> {
  const retries = Math.max(0, options?.retries ?? 0);
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 250);
  let attempt = 0;
  while (true) {
    try {
      const connection = await openChromeTarget(operations, url);
      if (messages.opened) logger(messages.opened(connection.targetId));
      return connection;
    } catch (error) {
      for (const message of describeTargetOpenFailure(error, messages)) logger(message);
      const exactFailure = findExactTargetOperationFailure(error);
      if (exactFailure || attempt >= retries) throw exactFailure ?? error;
      attempt += 1;
      await delay(retryDelayMs * attempt);
    }
  }
}

function createSessionBoundChromeClient(browser: ChromeClient, sessionId: string): ChromeClient {
  const browserWithEvents = browser as ChromeClient & {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    once: (event: string, listener: (...args: unknown[]) => void) => void;
    off?: (event: string, listener: (...args: unknown[]) => void) => void;
    removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
  };
  const bindDomain = <T extends object>(domainName: string): T => {
    const candidate: unknown = browser;
    const domain =
      candidate && typeof candidate === "object"
        ? (candidate as Record<string, unknown>)[domainName]
        : undefined;
    const domainRecord =
      domain && typeof domain === "object" ? (domain as Record<string, unknown>) : undefined;
    const eventName = (name: string) => `${domainName}.${name}.${sessionId}`;
    return new Proxy((domainRecord ?? {}) as T, {
      get(target, prop, receiver) {
        if (prop === "on") {
          return (name: string, listener: (...args: unknown[]) => void) => {
            const domainEvent = (target as Record<string, unknown>)[name];
            if (typeof domainEvent === "function") {
              return (domainEvent as (...args: unknown[]) => unknown)(sessionId, listener);
            }
            browserWithEvents.on(eventName(name), listener);
            return () => browserWithEvents.removeListener(eventName(name), listener);
          };
        }
        if (prop === "off" || prop === "removeListener") {
          return (name: string, listener: (...args: unknown[]) => void) => {
            const off =
              browserWithEvents.off ?? browserWithEvents.removeListener.bind(browserWithEvents);
            off(eventName(name), listener);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) =>
          (value as (...callArgs: unknown[]) => unknown)(...args, sessionId);
      },
    });
  };

  return {
    ...browser,
    // Raw `send` here is the browser-level send (not session-bound), so callers
    // that issue Target.* via `send` must pass this page session id explicitly to
    // stay scoped to this tab (e.g. Deep Research OOPIF auto-attach).
    // chrome-remote-interface defines `send` on the client prototype, so object
    // spread does not preserve it. Bind it explicitly for raw session commands.
    send: typeof browser.send === "function" ? browser.send.bind(browser) : undefined,
    oraclePageSessionId: sessionId,
    Network: bindDomain("Network"),
    Page: bindDomain("Page"),
    Runtime: bindDomain("Runtime"),
    Input: bindDomain("Input"),
    DOM: bindDomain("DOM"),
    Emulation: bindDomain("Emulation"),
    on: browserWithEvents.on.bind(browserWithEvents),
    once: browserWithEvents.once.bind(browserWithEvents),
    off:
      browserWithEvents.off?.bind(browserWithEvents) ??
      browserWithEvents.removeListener.bind(browserWithEvents),
    removeListener: browserWithEvents.removeListener.bind(browserWithEvents),
    close: async () => {
      await browser.Target.detachFromTarget({ sessionId }).catch(() => undefined);
    },
  } as ChromeClient;
}

export async function connectWithNewTab(
  port: number,
  logger: BrowserLogger,
  initialUrl?: string,
  host?: string,
  options?: { fallbackToDefault?: boolean; retries?: number; retryDelayMs?: number },
): Promise<IsolatedTabConnection> {
  const effectiveHost = host ?? "127.0.0.1";
  const fallbackToDefault = options?.fallbackToDefault ?? true;
  const fallbackLabel = fallbackToDefault
    ? "falling back to default target."
    : "strict mode: not falling back.";
  try {
    return await connectToNewTarget(
      rawChromeTargetOperations(effectiveHost, port),
      initialUrl ?? "about:blank",
      logger,
      {
        opened: (targetId) => `Opened isolated browser tab (target=${targetId})`,
        openFailed: (message) =>
          `Failed to open isolated browser tab (${message}); ${fallbackLabel}`,
        attachFailed: (targetId, message) =>
          `Failed to attach to isolated browser tab ${targetId} (${message}); ${fallbackLabel}`,
        closeFailed: (targetId, message) =>
          `Failed to close unused browser tab ${targetId}: ${message}`,
      },
      options,
    );
  } catch {
    if (!fallbackToDefault) {
      throw new Error("Failed to open isolated browser tab; refusing to attach to default target.");
    }
    return { client: await connectToChrome(port, logger, effectiveHost) };
  }
}

export async function connectWithNewTabWithRetainedLiveAuthority(
  port: number,
  logger: BrowserLogger,
  initialUrl = "about:blank",
  host = "127.0.0.1",
  options?: { retries?: number; retryDelayMs?: number },
): Promise<RemoteChromeConnection> {
  const retries = Math.max(0, options?.retries ?? 0);
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 250);
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const endpoint = await discoverBrowserWebSocketEndpoint(host, port);
      const connection = await connectToRemoteChromeTarget(host, port, logger, {
        browserWSEndpoint: endpoint.browserWSEndpoint,
        targetUrl: initialUrl,
        closeTargetOnDispose: false,
      });
      if (!connection.targetCloseAuthority) {
        await connection.close().catch(() => undefined);
        throw new Error("Chrome connection did not retain exact live target authority.");
      }
      return connection;
    } catch (error) {
      if (error instanceof ExactTargetCleanupUnconfirmedError) throw error;
      if (attempt >= retries) throw error;
      attempt += 1;
      logger(
        `Failed to open isolated browser tab with retained live authority (${error instanceof Error ? error.message : String(error)}); retrying.`,
      );
      await delay(retryDelayMs * attempt);
    }
  }
  throw new Error("Failed to open isolated browser tab with retained live authority");
}

async function confirmChromeTargetClosed(
  operations: ChromeTargetOperations,
  targetId: string,
  logger: BrowserLogger,
): Promise<boolean> {
  for (let attempt = 0; attempt < CLOSE_CONFIRM_ATTEMPTS; attempt += 1) {
    await delay(CLOSE_CONFIRM_DELAY_MS);
    try {
      if (!(await operations.list()).some((target) => target.targetId === targetId)) {
        logger(`Closed isolated browser tab (target=${targetId})`);
        return true;
      }
    } catch (error) {
      if (error instanceof ExactTargetOperationFailure) throw error;
    }
  }
  logger(`Browser tab close was not confirmed (target=${targetId})`);
  return false;
}

async function ensureChromePageTarget(
  operations: ChromeTargetOperations,
  closingTargetId: string,
  logger: BrowserLogger,
  knownTargets?: RemoteTargetInfo[],
): Promise<string | undefined> {
  let targets = knownTargets;
  if (!targets) {
    try {
      targets = await operations.list();
    } catch (error) {
      if (error instanceof ExactTargetOperationFailure) throw error;
      logger(
        `Failed to inspect Chrome tabs before closing ${closingTargetId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      targets = [];
    }
  }
  const existingPageTargetId = targets
    .filter((target) => target.type === "page")
    .map((target) => target.targetId)
    .find((targetId): targetId is string => Boolean(targetId) && targetId !== closingTargetId);
  if (existingPageTargetId) return existingPageTargetId;
  const replacementTargetId = await operations.create("about:blank");
  logger(`Opened replacement Chrome tab (target=${replacementTargetId})`);
  return replacementTargetId;
}

async function closeChromeTargetWithOperations(
  operations: ChromeTargetOperations,
  targetId: string,
  logger: BrowserLogger,
): Promise<boolean> {
  let targets: RemoteTargetInfo[];
  let listed = true;
  try {
    targets = await operations.list();
  } catch (error) {
    if (error instanceof ExactTargetOperationFailure) throw error;
    logger(
      `Failed to inspect Chrome tabs before closing ${targetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    listed = false;
    targets = [];
  }
  if (listed && targets.some((target) => target.targetId === targetId) === false) {
    logger(`Closed isolated browser tab (target=${targetId})`);
    return true;
  }
  try {
    const replacement = await ensureChromePageTarget(operations, targetId, logger, targets);
    if (!replacement) {
      logger(
        `[browser] Leaving browser tab ${targetId} open because Chrome has no replacement page target.`,
      );
      return false;
    }
    if (!(await operations.close(targetId))) {
      logger(`Browser tab close was rejected (target=${targetId})`);
      return false;
    }
  } catch (error) {
    try {
      if (!(await operations.list()).some((target) => target.targetId === targetId)) {
        logger(`Closed isolated browser tab (target=${targetId})`);
        return true;
      }
    } catch (confirmationError) {
      if (confirmationError instanceof ExactTargetOperationFailure) throw confirmationError;
    }
    throw error;
  }
  return await confirmChromeTargetClosed(operations, targetId, logger);
}

type BlankChromeTargetCleanup = {
  closed: number;
  failures: Array<{ targetId: string; reason: string }>;
};

async function closeBlankChromeTargets(
  operations: ChromeTargetOperations,
  options?: {
    excludeTargetIds?: Iterable<string | null | undefined>;
    preserveOneBlank?: boolean;
  },
): Promise<BlankChromeTargetCleanup> {
  const excluded = new Set(
    [...(options?.excludeTargetIds ?? [])].filter(
      (targetId): targetId is string => typeof targetId === "string" && targetId.length > 0,
    ),
  );
  const targets = await operations.list();
  const preservedBlankTargetId = options?.preserveOneBlank
    ? targets
        .filter(isBlankPageTarget)
        .map((target) => target.targetId)
        .filter((targetId): targetId is string => Boolean(targetId))
        .sort()[0]
    : undefined;
  const failures: BlankChromeTargetCleanup["failures"] = [];
  let closed = 0;
  for (const target of targets) {
    const targetId = target.targetId;
    if (
      !targetId ||
      targetId === preservedBlankTargetId ||
      excluded.has(targetId) ||
      !isBlankPageTarget(target)
    ) {
      continue;
    }
    try {
      if (!(await operations.close(targetId))) {
        throw new Error(`Chrome rejected blank target close for ${targetId}`);
      }
      closed += 1;
    } catch (error) {
      if (error instanceof ExactTargetOperationFailure) throw error;
      failures.push({ targetId, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { closed, failures };
}

export async function closeTab(
  port: number,
  targetId: string,
  logger: BrowserLogger,
  host?: string,
): Promise<boolean> {
  const operations = rawChromeTargetOperations(host ?? "127.0.0.1", port);
  try {
    await operations.close(targetId);
    return await confirmChromeTargetClosed(operations, targetId, logger);
  } catch (error) {
    try {
      if (!(await operations.list()).some((target) => target.targetId === targetId)) {
        logger(`Closed isolated browser tab (target=${targetId})`);
        return true;
      }
    } catch {
      // Preserve the close error below.
    }
    logger(
      `Failed to close browser tab ${targetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export async function closeChromeTarget(options: {
  port: number;
  targetId: string;
  logger: BrowserLogger;
  host?: string;
  browserWSEndpoint?: string;
}): Promise<boolean> {
  const host = options.host ?? "127.0.0.1";
  let browser: ChromeClient | undefined;
  try {
    const operations = options.browserWSEndpoint
      ? browserChromeTargetOperations(
          (browser = await CDP({ target: options.browserWSEndpoint, local: true })),
        )
      : rawChromeTargetOperations(host, options.port);
    return await closeChromeTargetWithOperations(operations, options.targetId, options.logger);
  } catch (error) {
    options.logger(
      `Failed to close browser tab ${options.targetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export type ExactChromeTargetCleanupResult =
  | { status: "completed" }
  | { status: "gone" }
  | { status: "unsafe"; reason: string };

async function runExactEndpointOperation<T>(
  authority: ExactChromeTargetOperationAuthority,
  operation: (client: ChromeClient) => Promise<T>,
): Promise<ExactChromeEndpointOperationResult<T>> {
  if (!authority.runExactOperation) {
    return {
      status: "unsafe",
      reason: "Retained Chrome endpoint authority cannot authenticate deferred target effects",
    };
  }
  return await authority.runExactOperation(operation);
}

function exactChromeTargetOperations(
  authority: ExactChromeTargetOperationAuthority,
): ChromeTargetOperations {
  const run = async <T>(operation: (client: ChromeClient) => Promise<T>): Promise<T> => {
    const result = await runExactEndpointOperation(authority, operation);
    if (result.status === "completed") return result.value;
    throw new ExactTargetOperationFailure(result);
  };
  return {
    list: async () =>
      await run(async (client) =>
        ((await client.Target.getTargets()).targetInfos ?? []).map(mapRemoteTarget),
      ),
    create: async (url) =>
      await run(async (client) => {
        const created = await client.Target.createTarget({ url });
        if (!created.targetId)
          throw new Error("Exact Chrome target creation returned no target id");
        return created.targetId;
      }),
    attach: async (targetId) =>
      await run(async (client) => {
        const attached = await client.Target.attachToTarget({ targetId, flatten: true });
        return createSessionBoundChromeClient(client, attached.sessionId);
      }),
    close: async (targetId) =>
      await run(
        async (client) => (await client.Target.closeTarget({ targetId })).success !== false,
      ),
  };
}

async function exactTargetResult<T>(
  operation: () => Promise<T>,
): Promise<ExactChromeEndpointOperationResult<T>> {
  try {
    return { status: "completed", value: await operation() };
  } catch (error) {
    const exactFailure = findExactTargetOperationFailure(error);
    if (exactFailure) return exactFailure.result;
    return {
      status: "unsafe",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export class ExactChromeEndpointAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExactChromeEndpointAuthorityError";
  }
}

export function requireExactChromeEndpointOperation<T>(
  result: ExactChromeEndpointOperationResult<T>,
  operation: string,
): T {
  if (result.status === "completed") return result.value;
  if (result.status === "gone") {
    throw new ExactChromeEndpointAuthorityError(
      `${operation}: exact Chrome process generation exited`,
    );
  }
  throw new ExactChromeEndpointAuthorityError(`${operation}: ${result.reason}`);
}

export async function connectToChromeTargetWithExactAuthority(options: {
  authority: RetainedChromeEndpointAuthority;
  targetId?: string;
  targetUrl?: string;
  closeTargetOnDispose?: boolean;
}): Promise<ExactChromeEndpointOperationResult<RemoteChromeConnection>> {
  const ownership: RemoteTargetOwnership = options.targetId ? "attached" : "created";
  const operations = exactChromeTargetOperations(options.authority);
  return await exactTargetResult(async () => {
    const connection = options.targetId
      ? { client: await operations.attach(options.targetId), targetId: options.targetId }
      : await openChromeTarget(operations, options.targetUrl ?? "about:blank");
    return {
      ...connection,
      ownership,
      browserWSEndpoint: options.authority.browserWSEndpoint,
      close: async () => {
        await connection.client.close().catch(() => undefined);
        if (!shouldCloseTargetOnDispose(ownership, options.closeTargetOnDispose)) return;
        if (!(await operations.close(connection.targetId))) {
          throw new Error(`Chrome rejected target close for ${connection.targetId}`);
        }
      },
    };
  });
}

export async function createChromePageTargetWithExactAuthority(
  authority: RetainedChromeEndpointAuthority,
  url = "about:blank",
): Promise<ExactChromeEndpointOperationResult<string>> {
  return await exactTargetResult(
    async () => await exactChromeTargetOperations(authority).create(url),
  );
}

export async function connectWithNewTabWithExactAuthority(
  authority: RetainedChromeEndpointAuthority,
  logger: BrowserLogger,
  initialUrl = "about:blank",
  options?: { retries?: number; retryDelayMs?: number },
): Promise<IsolatedTabConnection> {
  try {
    return await connectToNewTarget(
      exactChromeTargetOperations(authority),
      initialUrl,
      logger,
      {
        opened: (targetId) => `Opened isolated browser tab (target=${targetId})`,
        openFailed: (message) =>
          `Failed to open isolated browser tab through exact Chrome authority (${message}); retrying.`,
        attachFailed: (targetId, message) =>
          `Failed to attach to isolated browser tab ${targetId} through exact Chrome authority (${message}); retrying.`,
        closeFailed: (targetId, message) =>
          `Failed to close unused browser tab ${targetId} through exact Chrome authority: ${message}`,
      },
      options,
    );
  } catch (error) {
    if (error instanceof ExactTargetOperationFailure) {
      return requireExactChromeEndpointOperation(
        error.result,
        "Unable to open a tab through exact Chrome endpoint authority",
      );
    }
    throw error;
  }
}

export async function listChromeTargetsWithExactAuthority(
  authority: ExactChromeTargetOperationAuthority,
): Promise<ExactChromeEndpointOperationResult<RemoteTargetInfo[]>> {
  return await exactTargetResult(async () => await exactChromeTargetOperations(authority).list());
}

export async function closeChromeTargetWithExactAuthority(options: {
  authority: ExactChromeTargetOperationAuthority;
  targetId: string;
  logger: BrowserLogger;
}): Promise<ExactChromeTargetCleanupResult> {
  const result = await exactTargetResult(
    async () =>
      await closeChromeTargetWithOperations(
        exactChromeTargetOperations(options.authority),
        options.targetId,
        options.logger,
      ),
  );
  if (result.status !== "completed") return result;
  return result.value
    ? { status: "completed" }
    : { status: "unsafe", reason: `Chrome target close was not confirmed: ${options.targetId}` };
}

export async function closeBlankChromeTabsWithExactAuthority(
  authority: RetainedChromeEndpointAuthority,
  logger: BrowserLogger,
  options?: {
    excludeTargetIds?: Iterable<string | null | undefined>;
    preserveOneBlank?: boolean;
  },
): Promise<ExactChromeTargetCleanupResult> {
  const result = await exactTargetResult(
    async () => await closeBlankChromeTargets(exactChromeTargetOperations(authority), options),
  );
  if (result.status !== "completed") return result;
  if (result.value.failures.length > 0) {
    return { status: "unsafe", reason: result.value.failures[0].reason };
  }
  if (result.value.closed > 0) {
    logger(
      `Closed ${result.value.closed} blank Chrome tab${result.value.closed === 1 ? "" : "s"}.`,
    );
  }
  return { status: "completed" };
}

export async function createChromePageTarget(
  port: number,
  logger: BrowserLogger,
  host?: string,
  url = "about:blank",
): Promise<string | undefined> {
  try {
    const targetId = await rawChromeTargetOperations(host ?? "127.0.0.1", port).create(url);
    logger(`Opened replacement Chrome tab (target=${targetId})`);
    return targetId;
  } catch (error) {
    logger(
      `Failed to create a replacement Chrome tab: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

export async function ensureChromePageTargetAfterClose(
  port: number,
  closingTargetId: string,
  logger: BrowserLogger,
  host?: string,
): Promise<string | undefined> {
  try {
    return await ensureChromePageTarget(
      rawChromeTargetOperations(host ?? "127.0.0.1", port),
      closingTargetId,
      logger,
    );
  } catch (error) {
    logger(
      `Failed to create a replacement Chrome tab: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

export async function closeBlankChromeTabs(
  port: number,
  logger: BrowserLogger,
  host?: string,
  options?: {
    excludeTargetIds?: Iterable<string | null | undefined>;
    preserveOneBlank?: boolean;
  },
): Promise<void> {
  try {
    const cleanup = await closeBlankChromeTargets(
      rawChromeTargetOperations(host ?? "127.0.0.1", port),
      options,
    );
    for (const failure of cleanup.failures) {
      logger(`Failed to close blank Chrome tab ${failure.targetId}: ${failure.reason}`);
    }
    if (cleanup.closed > 0) {
      logger(`Closed ${cleanup.closed} blank Chrome tab${cleanup.closed === 1 ? "" : "s"}.`);
    }
  } catch (error) {
    logger(
      `Failed to inspect blank Chrome tabs: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isBlankPageTarget(target: { type?: string; url?: string }): boolean {
  if (target.type && target.type !== "page") return false;
  const url = (target.url ?? "").trim().toLowerCase();
  return url === "about:blank" || url === "chrome://newtab/" || url === "chrome://new-tab-page/";
}
