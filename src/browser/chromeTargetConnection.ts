import CDP from "chrome-remote-interface";
import type { BrowserLogger, ChromeClient } from "./types.js";
import {
  discoverBrowserWebSocketEndpoint,
  type ExactChromeEndpointOperationResult,
  type RetainedChromeEndpointAuthority,
} from "./chromeEndpointAuthority.js";
import {
  adaptDirectTargetChromeClient,
  type ChromeTargetAttachment,
  type BrowserLevelChromeClient,
  type SessionBoundChromeClient,
} from "./chromeSessionTransport.js";
import {
  browserChromeTargetOperations,
  closeBlankChromeTargets,
  closeChromeTargetWithOperations,
  confirmChromeTargetClosed,
  connectToNewTarget,
  ensureChromePageTarget,
  exactChromeTargetOperations,
  exactTargetResult,
  openChromeTarget,
  rawChromeTargetOperations,
  requireExactChromeEndpointOperation,
  ExactTargetOperationFailure,
  TargetOpenFailure,
  type ExactChromeTargetCleanupResult,
  type ExactChromeTargetOperationAuthority,
  type RemoteTargetInfo,
} from "./chromeTargetLifecycle.js";
import { delay } from "./utils.js";

export type {
  BrowserLevelChromeClient,
  SessionBoundChromeClient,
} from "./chromeSessionTransport.js";
export {
  ExactChromeEndpointAuthorityError,
  requireExactChromeEndpointOperation,
} from "./chromeTargetLifecycle.js";
export type {
  ExactChromeTargetCleanupResult,
  ExactChromeTargetOperationAuthority,
  RemoteTargetInfo,
} from "./chromeTargetLifecycle.js";

async function connectToDirectChromeTarget(port: number, logger: BrowserLogger, host?: string) {
  const attachment = adaptDirectTargetChromeClient(await CDP({ port, host }));
  logger("Connected to Chrome DevTools protocol");
  return attachment;
}

export async function connectToChrome(
  port: number,
  logger: BrowserLogger,
  host?: string,
): Promise<SessionBoundChromeClient> {
  return (await connectToDirectChromeTarget(port, logger, host)).client;
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

export interface RemoteChromeConnection {
  client: SessionBoundChromeClient;
  browserClient: BrowserLevelChromeClient;
  targetId: string;
  ownership: RemoteTargetOwnership;
  targetCloseAuthority?: RetainedLiveChromeTargetAuthority;
  browserWSEndpoint?: string;
  close: () => Promise<void>;
}

export interface IsolatedTabConnection {
  client: SessionBoundChromeClient;
  browserClient: BrowserLevelChromeClient;
  targetId?: string;
  targetCloseAuthority?: RetainedLiveChromeTargetAuthority;
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
    const attachment = await rawChromeTargetOperations(host, port).attach(options.targetId);
    return {
      ...attachment,
      targetId: options.targetId,
      ownership: "attached",
      close: async () => {
        await attachment.client.close().catch(() => undefined);
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
  let client: SessionBoundChromeClient | undefined;
  let browserClient: BrowserLevelChromeClient | undefined;
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
    let attachment: ChromeTargetAttachment;
    if (targetId) {
      attachment = await operations.attach(targetId);
    } else {
      const opened = await openChromeTarget(operations, options.targetUrl ?? "about:blank");
      attachment = opened;
      targetId = opened.targetId;
      logger(`Opened dedicated remote Chrome tab targeting ${options.targetUrl ?? "about:blank"}`);
    }
    client = attachment.client;
    browserClient = attachment.browserClient;
    if (!targetId) throw new Error("Chrome target attachment returned no target id");
    return {
      client,
      browserClient,
      targetId,
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
    return await CDP({ target: browserWSEndpoint, local: true });
  }

  logger(`Waiting for Chrome remote debugging approval for ${host}:${port}...`);
  const deadline = Date.now() + approvalWaitMs;
  let lastApprovalError: unknown;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    try {
      return await Promise.race([
        CDP({ target: browserWSEndpoint, local: true }),
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
      const message = error instanceof Error ? error.message : String(error ?? "");
      if (!/unexpected server response:\s*403|remote debugging|forbidden/i.test(message)) {
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
  const wait = approvalWaitMs % 1000 === 0 ? `${approvalWaitMs / 1000}s` : `${approvalWaitMs}ms`;
  throw new Error(
    `Oracle waited ${wait} for Chrome remote debugging approval at ${host}:${port}. Allow the Chrome prompt or retry after toggling remote debugging.${suffix}`,
  );
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
    return await connectToDirectChromeTarget(port, logger, effectiveHost);
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
      ? { ...(await operations.attach(options.targetId)), targetId: options.targetId }
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
