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

export async function listRemoteChromeTargets(options: {
  host: string;
  port: number;
  browserWSEndpoint?: string;
}): Promise<RemoteTargetInfo[]> {
  if (!options.browserWSEndpoint) {
    const targets = (await CDP.List({ host: options.host, port: options.port })) as Array<{
      id?: string;
      targetId?: string;
      type?: string;
      title?: string;
      url?: string;
    }>;
    return targets.map((target) => ({
      targetId: target.targetId ?? target.id,
      type: target.type,
      title: target.title,
      url: target.url,
    }));
  }
  const browser = await CDP({ target: options.browserWSEndpoint, local: true });
  try {
    const result = await browser.Target.getTargets();
    return (result.targetInfos ?? []).map((target) => ({
      targetId: target.targetId,
      type: target.type,
      title: target.title,
      url: target.url,
    }));
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
    const client = await CDP({ host, port, target: options.targetId });
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
  const ownership: RemoteTargetOwnership = options.targetId ? "attached" : "created";
  let targetId = options.targetId;
  let attachedSessionId: string | null = null;
  let browserReleased = false;
  let closeTargetOnRelease = shouldCloseTargetOnDispose(ownership, options.closeTargetOnDispose);
  const releaseBrowser = async (): Promise<void> => {
    if (browserReleased) return;
    if (attachedSessionId) {
      await browser.Target.detachFromTarget({ sessionId: attachedSessionId }).catch(
        () => undefined,
      );
    }
    if (closeTargetOnRelease && targetId) {
      const closed = await browser.Target.closeTarget({ targetId });
      if (closed.success === false) {
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
    if (!targetId) {
      const created = await browser.Target.createTarget({
        url: options.targetUrl ?? "about:blank",
      });
      targetId = created.targetId;
      logger(`Opened dedicated remote Chrome tab targeting ${options.targetUrl ?? "about:blank"}`);
    }
    const attached = await browser.Target.attachToTarget({ targetId, flatten: true });
    attachedSessionId = attached.sessionId;
    const client = createSessionBoundChromeClient(browser, attached.sessionId);
    return {
      client,
      targetId,
      browserWSEndpoint: options.browserWSEndpoint,
      ownership,
      targetCloseAuthority,
      close: releaseBrowser,
    };
  } catch (error) {
    let cleanupError: unknown;
    if (ownership === "created" && targetId) {
      try {
        const closed = await browser.Target.closeTarget({ targetId });
        if (closed.success === false) {
          throw new Error(`Chrome rejected cleanup of unused target ${targetId}`);
        }
        closeTargetOnRelease = false;
      } catch (closeError) {
        cleanupError = closeError;
        const message = closeError instanceof Error ? closeError.message : String(closeError);
        logger(`Failed to close unused remote Chrome tab ${targetId}: ${message}`);
      }
    }
    await releaseBrowser().catch(() => undefined);
    if (cleanupError) {
      throw new ExactTargetCleanupUnconfirmedError(
        `Remote Chrome target acquisition failed and cleanup was not confirmed for ${targetId}`,
        new AggregateError([error, cleanupError], "Remote target acquisition and cleanup failed"),
      );
    }
    throw error;
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

async function connectToNewTarget(
  host: string,
  port: number,
  url: string,
  logger: BrowserLogger,
  messages: TargetConnectMessages,
): Promise<{ client: ChromeClient; targetId: string } | null> {
  try {
    const target = await CDP.New({ host, port, url });
    try {
      const client = await CDP({ host, port, target: target.id });
      if (messages.opened) {
        logger(messages.opened(target.id));
      }
      return { client, targetId: target.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(messages.attachFailed(target.id, message));
      try {
        await CDP.Close({ host, port, id: target.id });
      } catch (closeError) {
        const closeMessage = closeError instanceof Error ? closeError.message : String(closeError);
        logger(messages.closeFailed(target.id, closeMessage));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(messages.openFailed(message));
  }
  return null;
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
  const url = initialUrl ?? "about:blank";
  const fallbackToDefault = options?.fallbackToDefault ?? true;
  const retries = Math.max(0, options?.retries ?? 0);
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 250);
  const fallbackLabel = fallbackToDefault
    ? "falling back to default target."
    : "strict mode: not falling back.";

  let attempt = 0;
  while (attempt <= retries) {
    const targetConnection = await connectToNewTarget(effectiveHost, port, url, logger, {
      opened: (targetId) => `Opened isolated browser tab (target=${targetId})`,
      openFailed: (message) => `Failed to open isolated browser tab (${message}); ${fallbackLabel}`,
      attachFailed: (targetId, message) =>
        `Failed to attach to isolated browser tab ${targetId} (${message}); ${fallbackLabel}`,
      closeFailed: (targetId, message) =>
        `Failed to close unused browser tab ${targetId}: ${message}`,
    });
    if (targetConnection) {
      return targetConnection;
    }
    if (attempt >= retries) {
      break;
    }
    attempt += 1;
    await delay(retryDelayMs * attempt);
  }

  if (!fallbackToDefault) {
    throw new Error("Failed to open isolated browser tab; refusing to attach to default target.");
  }
  const client = await connectToChrome(port, logger, effectiveHost);
  return { client };
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

export async function closeTab(
  port: number,
  targetId: string,
  logger: BrowserLogger,
  host?: string,
): Promise<boolean> {
  const effectiveHost = host ?? "127.0.0.1";
  try {
    await CDP.Close({ host: effectiveHost, port, id: targetId });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(25);
      let targets: Array<{ id?: string; targetId?: string }>;
      try {
        targets = (await CDP.List({ host: effectiveHost, port })) as Array<{
          id?: string;
          targetId?: string;
        }>;
      } catch {
        continue;
      }
      if (!targets.some((target) => (target.targetId ?? target.id) === targetId)) {
        logger(`Closed isolated browser tab (target=${targetId})`);
        return true;
      }
    }
    logger(`Browser tab close was not confirmed (target=${targetId})`);
    return false;
  } catch (error) {
    try {
      const targets = (await CDP.List({ host: effectiveHost, port })) as Array<{
        id?: string;
        targetId?: string;
      }>;
      if (!targets.some((target) => (target.targetId ?? target.id) === targetId)) {
        logger(`Closed isolated browser tab (target=${targetId})`);
        return true;
      }
    } catch {
      // Preserve the original close error below.
    }
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to close browser tab ${targetId}: ${message}`);
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
  if (!options.browserWSEndpoint) {
    const replacement = await ensureChromePageTargetAfterClose(
      options.port,
      options.targetId,
      options.logger,
      host,
    );
    if (!replacement) {
      options.logger(
        `[browser] Leaving browser tab ${options.targetId} open because Chrome has no replacement page target.`,
      );
      return false;
    }
    return closeTab(options.port, options.targetId, options.logger, host);
  }

  let browser: Awaited<ReturnType<typeof CDP>> | null = null;
  try {
    browser = await CDP({ target: options.browserWSEndpoint, local: true });
    const readTargets = async () => (await browser!.Target.getTargets()).targetInfos ?? [];
    const targets = await readTargets();
    if (!targets.some((target) => target.targetId === options.targetId)) {
      options.logger(`Closed isolated browser tab (target=${options.targetId})`);
      return true;
    }
    if (!targets.some((target) => target.type === "page" && target.targetId !== options.targetId)) {
      const created = await browser.Target.createTarget({ url: "about:blank" });
      if (!created.targetId) {
        options.logger(
          `[browser] Leaving browser tab ${options.targetId} open because Chrome has no replacement page target.`,
        );
        return false;
      }
      options.logger(`Opened replacement Chrome tab (target=${created.targetId})`);
    }
    const closed = await browser.Target.closeTarget({ targetId: options.targetId });
    if (closed.success === false) {
      options.logger(`Browser tab close was rejected (target=${options.targetId})`);
      return false;
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(25);
      if (!(await readTargets()).some((target) => target.targetId === options.targetId)) {
        options.logger(`Closed isolated browser tab (target=${options.targetId})`);
        return true;
      }
    }
    options.logger(`Browser tab close was not confirmed (target=${options.targetId})`);
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.logger(`Failed to close browser tab ${options.targetId}: ${message}`);
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
  return await runExactEndpointOperation(options.authority, async (browser) => {
    let targetId = options.targetId;
    if (!targetId) {
      const created = await browser.Target.createTarget({
        url: options.targetUrl ?? "about:blank",
      });
      targetId = created.targetId;
      if (!targetId) throw new Error("Exact Chrome target creation returned no target id");
    }
    const connectedTargetId = targetId;

    let sessionId: string;
    try {
      const attached = await browser.Target.attachToTarget({
        targetId: connectedTargetId,
        flatten: true,
      });
      sessionId = attached.sessionId;
    } catch (error) {
      if (ownership === "created") {
        try {
          const closed = await browser.Target.closeTarget({ targetId: connectedTargetId });
          if (closed.success === false) {
            throw new Error(`Chrome rejected cleanup of unattached target ${connectedTargetId}`);
          }
        } catch (closeError) {
          throw new ExactTargetCleanupUnconfirmedError(
            `Exact Chrome target attach failed and cleanup was not confirmed for ${connectedTargetId}`,
            new AggregateError(
              [error, closeError],
              `Attach and cleanup both failed for exact Chrome target ${connectedTargetId}`,
            ),
          );
        }
      }
      throw error;
    }

    const client = createSessionBoundChromeClient(browser, sessionId);
    return {
      client,
      targetId: connectedTargetId,
      ownership,
      browserWSEndpoint: options.authority.browserWSEndpoint,
      close: async () => {
        await client.close().catch(() => undefined);
        if (!shouldCloseTargetOnDispose(ownership, options.closeTargetOnDispose)) return;
        const closed = await runExactEndpointOperation(options.authority, async (exactClient) =>
          exactClient.Target.closeTarget({ targetId: connectedTargetId }),
        );
        const result = requireExactChromeEndpointOperation(
          closed,
          `Unable to close exact Chrome target ${connectedTargetId}`,
        );
        if (result.success === false) {
          throw new Error(`Chrome rejected target close for ${connectedTargetId}`);
        }
      },
    };
  });
}

export async function createChromePageTargetWithExactAuthority(
  authority: RetainedChromeEndpointAuthority,
  url = "about:blank",
): Promise<ExactChromeEndpointOperationResult<string>> {
  return await runExactEndpointOperation(authority, async (client) => {
    const created = await client.Target.createTarget({ url });
    if (!created.targetId) throw new Error("Exact Chrome target creation returned no target id");
    return created.targetId;
  });
}

export async function connectWithNewTabWithExactAuthority(
  authority: RetainedChromeEndpointAuthority,
  logger: BrowserLogger,
  initialUrl = "about:blank",
  options?: { retries?: number; retryDelayMs?: number },
): Promise<IsolatedTabConnection> {
  const retries = Math.max(0, options?.retries ?? 0);
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 250);
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const result = await connectToChromeTargetWithExactAuthority({
        authority,
        targetUrl: initialUrl,
      });
      const connection = requireExactChromeEndpointOperation(
        result,
        "Unable to open a tab through exact Chrome endpoint authority",
      );
      logger(`Opened isolated browser tab (target=${connection.targetId})`);
      return { client: connection.client, targetId: connection.targetId };
    } catch (error) {
      if (
        error instanceof ExactChromeEndpointAuthorityError ||
        error instanceof ExactTargetCleanupUnconfirmedError ||
        attempt >= retries
      ) {
        throw error;
      }
      attempt += 1;
      logger(
        `Failed to open isolated browser tab through exact Chrome authority (${error instanceof Error ? error.message : String(error)}); retrying.`,
      );
      await delay(retryDelayMs * attempt);
    }
  }
  throw new Error("Failed to open isolated browser tab through exact Chrome endpoint authority");
}

export async function listChromeTargetsWithExactAuthority(
  authority: ExactChromeTargetOperationAuthority,
): Promise<ExactChromeEndpointOperationResult<RemoteTargetInfo[]>> {
  return await runExactEndpointOperation(authority, async (client) => {
    const targetInfos = (await client.Target.getTargets()).targetInfos ?? [];
    return targetInfos.map((target) => ({
      targetId: target.targetId,
      type: target.type,
      title: target.title,
      url: target.url,
    }));
  });
}

export async function closeChromeTargetWithExactAuthority(options: {
  authority: ExactChromeTargetOperationAuthority;
  targetId: string;
  logger: BrowserLogger;
}): Promise<ExactChromeTargetCleanupResult> {
  const { authority, targetId, logger } = options;
  try {
    const initial = await listChromeTargetsWithExactAuthority(authority);
    if (initial.status !== "completed") return initial;
    if (!initial.value.some((target) => target.targetId === targetId)) {
      logger(`Closed isolated browser tab (target=${targetId})`);
      return { status: "completed" };
    }
    if (
      !initial.value.some(
        (target) => target.type === "page" && target.targetId && target.targetId !== targetId,
      )
    ) {
      const replacement = await runExactEndpointOperation(authority, async (client) =>
        client.Target.createTarget({ url: "about:blank" }),
      );
      if (replacement.status !== "completed") return replacement;
      if (!replacement.value.targetId) {
        return {
          status: "unsafe",
          reason: `Chrome has no replacement page target for ${targetId}`,
        };
      }
      logger(`Opened replacement Chrome tab (target=${replacement.value.targetId})`);
    }

    const close = await runExactEndpointOperation(authority, async (client) =>
      client.Target.closeTarget({ targetId }),
    );
    if (close.status !== "completed") return close;
    if (close.value.success === false) {
      return { status: "unsafe", reason: `Chrome rejected target close for ${targetId}` };
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(25);
      const current = await listChromeTargetsWithExactAuthority(authority);
      if (current.status === "gone") return current;
      if (current.status === "unsafe") return current;
      if (!current.value.some((target) => target.targetId === targetId)) {
        logger(`Closed isolated browser tab (target=${targetId})`);
        return { status: "completed" };
      }
    }
    return { status: "unsafe", reason: `Chrome target close was not confirmed: ${targetId}` };
  } catch (error) {
    return {
      status: "unsafe",
      reason: `Exact Chrome target cleanup failed: ${error instanceof Error ? error.message : error}`,
    };
  }
}

export async function closeBlankChromeTabsWithExactAuthority(
  authority: RetainedChromeEndpointAuthority,
  logger: BrowserLogger,
  options?: {
    excludeTargetIds?: Iterable<string | null | undefined>;
    preserveOneBlank?: boolean;
  },
): Promise<ExactChromeTargetCleanupResult> {
  const excluded = new Set(
    [...(options?.excludeTargetIds ?? [])].filter(
      (targetId): targetId is string => typeof targetId === "string" && targetId.length > 0,
    ),
  );
  try {
    const listed = await listChromeTargetsWithExactAuthority(authority);
    if (listed.status !== "completed") return listed;
    const preservedBlankTargetId = options?.preserveOneBlank
      ? listed.value
          .filter(isBlankPageTarget)
          .map((target) => target.targetId)
          .filter((targetId): targetId is string => Boolean(targetId))
          .sort()[0]
      : undefined;
    let closed = 0;
    for (const target of listed.value) {
      const targetId = target.targetId;
      if (
        !targetId ||
        targetId === preservedBlankTargetId ||
        excluded.has(targetId) ||
        !isBlankPageTarget(target)
      ) {
        continue;
      }
      const close = await runExactEndpointOperation(authority, async (client) =>
        client.Target.closeTarget({ targetId }),
      );
      if (close.status !== "completed") return close;
      if (close.value.success === false) {
        return { status: "unsafe", reason: `Chrome rejected blank target close for ${targetId}` };
      }
      closed += 1;
    }
    if (closed > 0) {
      logger(`Closed ${closed} blank Chrome tab${closed === 1 ? "" : "s"}.`);
    }
    return { status: "completed" };
  } catch (error) {
    return {
      status: "unsafe",
      reason: `Exact blank-tab cleanup failed: ${error instanceof Error ? error.message : error}`,
    };
  }
}

export async function createChromePageTarget(
  port: number,
  logger: BrowserLogger,
  host?: string,
  url = "about:blank",
): Promise<string | undefined> {
  const effectiveHost = host ?? "127.0.0.1";
  try {
    const created = (await CDP.New({
      host: effectiveHost,
      port,
      url,
    })) as { id?: string; targetId?: string };
    const createdTargetId = created.targetId ?? created.id;
    if (!createdTargetId) {
      logger("Failed to create a replacement Chrome tab.");
      return undefined;
    }
    logger(`Opened replacement Chrome tab (target=${createdTargetId})`);
    return createdTargetId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to create a replacement Chrome tab: ${message}`);
    return undefined;
  }
}

export async function ensureChromePageTargetAfterClose(
  port: number,
  closingTargetId: string,
  logger: BrowserLogger,
  host?: string,
): Promise<string | undefined> {
  const effectiveHost = host ?? "127.0.0.1";
  try {
    const targets = (await CDP.List({ host: effectiveHost, port })) as Array<{
      id?: string;
      targetId?: string;
      type?: string;
    }>;
    const existingPageTargetId = targets
      .filter((target) => target.type === "page")
      .map((target) => target.targetId ?? target.id)
      .find((targetId): targetId is string => Boolean(targetId) && targetId !== closingTargetId);
    if (existingPageTargetId) {
      return existingPageTargetId;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to inspect Chrome tabs before closing ${closingTargetId}: ${message}`);
  }
  return await createChromePageTarget(port, logger, host);
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
  const effectiveHost = host ?? "127.0.0.1";
  const excluded = new Set(
    [...(options?.excludeTargetIds ?? [])].filter(
      (targetId): targetId is string => typeof targetId === "string" && targetId.length > 0,
    ),
  );
  let targets: Array<{ id?: string; targetId?: string; type?: string; url?: string }>;
  try {
    targets = (await CDP.List({ host: effectiveHost, port })) as Array<{
      id?: string;
      targetId?: string;
      type?: string;
      url?: string;
    }>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to inspect blank Chrome tabs: ${message}`);
    return;
  }

  const preservedBlankTargetId = options?.preserveOneBlank
    ? targets
        .filter(isBlankPageTarget)
        .map((target) => target.targetId ?? target.id)
        .filter((targetId): targetId is string => Boolean(targetId))
        .sort()[0]
    : undefined;
  let closed = 0;
  for (const target of targets) {
    const targetId = target.targetId ?? target.id;
    if (
      !targetId ||
      targetId === preservedBlankTargetId ||
      excluded.has(targetId) ||
      !isBlankPageTarget(target)
    ) {
      continue;
    }
    try {
      await CDP.Close({ host: effectiveHost, port, id: targetId });
      closed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to close blank Chrome tab ${targetId}: ${message}`);
    }
  }
  if (closed > 0) {
    logger(`Closed ${closed} blank Chrome tab${closed === 1 ? "" : "s"}.`);
  }
}

function isBlankPageTarget(target: { type?: string; url?: string }): boolean {
  if (target.type && target.type !== "page") {
    return false;
  }
  const url = (target.url ?? "").trim().toLowerCase();
  return url === "about:blank" || url === "chrome://newtab/" || url === "chrome://new-tab-page/";
}
