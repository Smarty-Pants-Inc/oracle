import { rm } from "node:fs/promises";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import CDP from "chrome-remote-interface";
import { launch, Launcher, type LaunchedChrome } from "chrome-launcher";
import type { BrowserLogger, ResolvedBrowserConfig, ChromeClient } from "./types.js";
import {
  captureChromeProcessIdentity,
  cleanupStaleProfileState,
  findRunningChromeDebugTargetForProfile,
  terminateRecordedChromeForProfile,
  writeChromeProcessIdentity,
  type ChromeProcessIdentity,
} from "./profileState.js";
import { delay } from "./utils.js";
import { isWsl, resolveWslChromeLaunchRoute } from "./wslHost.js";
const execFileAsync = promisify(execFile);

export type ChromeLaunchResult = Omit<LaunchedChrome, "kill"> & {
  kill: () => Promise<void>;
  host?: string;
  processIdentity: ChromeProcessIdentity;
};
type CapturedChromeLaunch = LaunchedChrome & {
  host?: string;
  processIdentity: ChromeProcessIdentity;
};

export interface ChromeLaunchDeps {
  platform?: NodeJS.Platform;
  standardLaunch?: typeof launch;
  customHostLaunch?: typeof launchWithCustomHost;
  hiddenMacLaunch?: typeof launchHiddenMacChrome;
  resolveLaunchRoute?: typeof resolveWslChromeLaunchRoute;
  captureProcessIdentity?: typeof captureChromeProcessIdentity;
  writeProcessIdentity?: typeof writeChromeProcessIdentity;
  terminateRecordedProcess?: typeof terminateRecordedChromeForProfile;
}

export async function launchChrome(
  config: ResolvedBrowserConfig,
  userDataDir: string,
  logger: BrowserLogger,
  deps: ChromeLaunchDeps = {},
): Promise<ChromeLaunchResult> {
  const { connectHost, debugBindAddress, usePatchedLauncher } = (
    deps.resolveLaunchRoute ?? resolveWslChromeLaunchRoute
  )();
  const debugPort = config.debugPort ?? parseDebugPortEnv();
  const chromeFlags = buildChromeFlags(
    config.headless ?? false,
    debugBindAddress,
    config.hideWindow ?? false,
  );
  // copy-profile reuses a copied signed-in profile whose cookies are
  // Keychain-encrypted, so it must launch with the real Keychain (not mocked):
  // strip the keychain-mocking flags from both chrome-launcher's defaults and
  // Oracle's set, and ignore the defaults so they aren't re-added.
  const usingCopiedProfile = Boolean(config.copyProfileSource);
  if (usingCopiedProfile && config.chromeProfile) {
    chromeFlags.push(`--profile-directory=${config.chromeProfile}`);
  }
  const launchOptions = resolveChromeLaunchOptions(chromeFlags, usingCopiedProfile);
  const platform = deps.platform ?? process.platform;
  const hiddenHeadfulLaunch = Boolean(config.hideWindow && !config.headless);
  if (hiddenHeadfulLaunch && platform !== "darwin") {
    throw new Error(
      "Hidden background Chrome launch is only supported on macOS; use --remote-chrome with a dedicated background browser.",
    );
  }

  let launcher: LaunchedChrome & { host?: string };
  let processIdentity: ChromeProcessIdentity | undefined;
  if (hiddenHeadfulLaunch) {
    const hiddenLauncher = await (deps.hiddenMacLaunch ?? launchHiddenMacChrome)({
      chromeFlags: launchOptions.chromeFlags,
      chromePath: config.chromePath ?? undefined,
      userDataDir,
      requestedPort: debugPort ?? undefined,
      ignoreDefaultFlags: launchOptions.ignoreDefaultFlags,
      captureProcessIdentity: deps.captureProcessIdentity ?? captureChromeProcessIdentity,
    });
    launcher = hiddenLauncher;
    processIdentity = hiddenLauncher.processIdentity;
  } else if (usePatchedLauncher) {
    launcher = await (deps.customHostLaunch ?? launchWithCustomHost)({
      chromeFlags: launchOptions.chromeFlags,
      chromePath: config.chromePath ?? undefined,
      userDataDir,
      host: connectHost ?? "127.0.0.1",
      requestedPort: debugPort ?? undefined,
      ignoreDefaultFlags: launchOptions.ignoreDefaultFlags,
    });
  } else {
    launcher = Object.assign(
      await (deps.standardLaunch ?? launch)({
        chromePath: config.chromePath ?? undefined,
        chromeFlags: launchOptions.chromeFlags,
        userDataDir,
        handleSIGINT: false,
        port: debugPort ?? undefined,
        ignoreDefaultFlags: launchOptions.ignoreDefaultFlags,
      }),
      { host: "127.0.0.1" },
    );
  }
  processIdentity ??= await captureLaunchedChromeProcessIdentity(
    userDataDir,
    launcher,
    deps.captureProcessIdentity ?? captureChromeProcessIdentity,
  );
  const kill = await createProvisionalIdentityBoundChromeKill(
    userDataDir,
    processIdentity,
    launcher.kill.bind(launcher),
    {
      writeIdentity: deps.writeProcessIdentity,
      terminate: deps.terminateRecordedProcess,
    },
  );
  const pidLabel = typeof launcher.pid === "number" ? ` (pid ${launcher.pid})` : "";
  const hostLabel = connectHost ? ` on ${connectHost}` : "";
  logger(
    `${hiddenHeadfulLaunch ? "Launched hidden background Chrome" : "Launched Chrome"}${pidLabel} on port ${launcher.port}${hostLabel}`,
  );
  return Object.assign(launcher, {
    host: connectHost ?? "127.0.0.1",
    processIdentity,
    kill,
  }) as ChromeLaunchResult;
}

async function captureLaunchedChromeProcessIdentity(
  userDataDir: string,
  launcher: LaunchedChrome,
  capture: typeof captureChromeProcessIdentity,
): Promise<ChromeProcessIdentity> {
  const pid = launcher.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    const identityError = new Error(
      `Launched Chrome for ${userDataDir} did not report a valid process id.`,
    );
    try {
      await launcher.kill();
    } catch (rollbackError) {
      throw new AggregateError(
        [identityError, rollbackError],
        `Launched Chrome for ${userDataDir} did not report a valid process id, and launch rollback also failed.`,
      );
    }
    throw identityError;
  }
  try {
    return await capture(userDataDir, pid);
  } catch (error) {
    try {
      await launcher.kill();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Failed to capture Chrome process identity for ${userDataDir}, and launch rollback also failed.`,
      );
    }
    throw new Error(`Failed to capture Chrome process identity for ${userDataDir}.`, {
      cause: error,
    });
  }
}

export function createIdentityBoundChromeKill(
  userDataDir: string,
  processIdentity: ChromeProcessIdentity,
  terminate: typeof terminateRecordedChromeForProfile = terminateRecordedChromeForProfile,
): () => Promise<void> {
  return async () => {
    await terminate(userDataDir, processIdentity);
  };
}

export async function createProvisionalIdentityBoundChromeKill(
  userDataDir: string,
  processIdentity: ChromeProcessIdentity,
  rollbackKill: () => void | Promise<void>,
  deps: {
    writeIdentity?: typeof writeChromeProcessIdentity;
    terminate?: typeof terminateRecordedChromeForProfile;
  } = {},
): Promise<() => Promise<void>> {
  try {
    await (deps.writeIdentity ?? writeChromeProcessIdentity)(userDataDir, processIdentity);
  } catch (error) {
    try {
      await rollbackKill();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Failed to persist Chrome process identity for ${userDataDir}, and launch rollback also failed.`,
      );
    }
    throw new Error(`Failed to persist Chrome process identity for ${userDataDir}.`, {
      cause: error,
    });
  }
  return createIdentityBoundChromeKill(userDataDir, processIdentity, deps.terminate);
}

export async function positionChromeWindowOffscreen(
  client: ChromeClient,
  logger: BrowserLogger,
): Promise<void> {
  if (process.platform !== "darwin") {
    logger("Window hiding is only supported on macOS");
    return;
  }
  try {
    const { windowId } = await client.Browser.getWindowForTarget();
    await client.Browser.setWindowBounds({
      windowId,
      bounds: { left: -32_000, top: -32_000, windowState: "normal" },
    });
    logger("Chrome window positioned off-screen");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to position Chrome window off-screen: ${message}`);
  }
}

export function registerTerminationHooks(
  chrome: LaunchedChrome,
  userDataDir: string,
  keepBrowser: boolean,
  logger: BrowserLogger,
  opts?: {
    /** Return true when the run is still in-flight (assistant response pending). */
    isInFlight?: () => boolean;
    /** Persist runtime hints so reattach can find the live Chrome. */
    emitRuntimeHint?: () => Promise<void>;
    /** Preserve the profile directory even when Chrome is terminated. */
    preserveUserDataDir?: boolean;
    /**
     * Always terminate Chrome and delete `userDataDir` on signal, even when the run is
     * in-flight — for throwaway copied profiles (`--copy-profile`) that must not be left
     * on disk. Overrides the in-flight "leave running" behavior.
     */
    forceProfileCleanup?: boolean;
  },
): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGQUIT"];
  let handling: boolean | undefined;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (handling) {
      return;
    }
    handling = true;
    const inFlight = opts?.isInFlight?.() ?? false;
    const forceCleanup = opts?.forceProfileCleanup ?? false;
    const leaveRunning = (keepBrowser || inFlight) && !forceCleanup;
    if (leaveRunning) {
      logger(
        `Received ${signal}; leaving Chrome running${inFlight ? " (assistant response pending)" : ""}`,
      );
    } else if (forceCleanup && (keepBrowser || inFlight)) {
      logger(
        `Received ${signal}; terminating Chrome and removing the copied profile (copy-profile is not retained)`,
      );
    } else {
      logger(`Received ${signal}; terminating Chrome process`);
    }
    void (async () => {
      if (leaveRunning) {
        // Ensure reattach hints are written before we exit.
        await opts?.emitRuntimeHint?.().catch(() => undefined);
        if (inFlight) {
          logger('Session still in flight; reattach with "oracle session <slug>" to continue.');
        }
      } else {
        try {
          await chrome.kill();
        } catch {
          // ignore kill failures
        }
        if (opts?.preserveUserDataDir) {
          // Preserve the profile directory (manual login), but clear reattach hints so we don't
          // try to reuse a dead DevTools port on the next run.
          await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
            () => undefined,
          );
        } else {
          await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    })().finally(() => {
      const exitCode = signal === "SIGINT" ? 130 : 1;
      // Vitest treats any `process.exit()` call as an unhandled failure, even if mocked.
      // Keep production behavior (hard-exit on signals) while letting tests observe state changes.
      process.exitCode = exitCode;
      const isTestRun = process.env.VITEST === "1" || process.env.NODE_ENV === "test";
      if (!isTestRun) {
        process.exit(exitCode);
      }
    });
  };

  for (const signal of signals) {
    process.on(signal, handleSignal);
  }

  return () => {
    for (const signal of signals) {
      process.removeListener(signal, handleSignal);
    }
  };
}

export async function connectToChrome(
  port: number,
  logger: BrowserLogger,
  host?: string,
): Promise<ChromeClient> {
  const client = await CDP({ port, host });
  logger("Connected to Chrome DevTools protocol");
  return client;
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
    const targetConnection = await connectToNewTarget(host, port, targetUrl, logger, {
      opened: () => `Opened dedicated remote Chrome tab targeting ${targetUrl}`,
      openFailed: (message) =>
        `Failed to open dedicated remote Chrome tab (${message}); falling back to an existing page target.`,
      attachFailed: (targetId, message) =>
        `Failed to attach to dedicated remote Chrome tab ${targetId} (${message}); falling back to an existing page target.`,
      closeFailed: (targetId, message) =>
        `Failed to close unused remote Chrome tab ${targetId}: ${message}`,
    });
    if (targetConnection) {
      return {
        client: targetConnection.client,
        targetId: targetConnection.targetId,
        ownership: "created",
        close: async () => {
          await targetConnection.client.close().catch(() => undefined);
        },
      };
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

export interface RemoteChromeConnection {
  client: ChromeClient;
  targetId: string;
  ownership: RemoteTargetOwnership;
  browserWSEndpoint?: string;
  close: () => Promise<void>;
}

export interface IsolatedTabConnection {
  client: ChromeClient;
  targetId?: string;
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
      url?: string;
    }>;
    return targets.map((target) => ({
      targetId: target.targetId ?? target.id,
      type: target.type,
      url: target.url,
    }));
  }
  const browser = await CDP({ target: options.browserWSEndpoint, local: true });
  try {
    const result = await browser.Target.getTargets();
    return (result.targetInfos ?? []).map((target) => ({
      targetId: target.targetId,
      type: target.type,
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
  try {
    if (!targetId) {
      const created = await browser.Target.createTarget({
        url: options.targetUrl ?? "about:blank",
      });
      targetId = created.targetId;
      logger(`Opened dedicated remote Chrome tab targeting ${options.targetUrl ?? "about:blank"}`);
    }
    const attached = await browser.Target.attachToTarget({ targetId, flatten: true });
    const client = createSessionBoundChromeClient(browser, attached.sessionId);
    return {
      client,
      targetId,
      browserWSEndpoint: options.browserWSEndpoint,
      ownership,
      close: async () => {
        await browser.Target.detachFromTarget({ sessionId: attached.sessionId }).catch(
          () => undefined,
        );
        if (options.closeTargetOnDispose && targetId) {
          await browser.Target.closeTarget({ targetId }).catch(() => undefined);
        }
        await browser.close().catch(() => undefined);
      },
    };
  } catch (error) {
    if (ownership === "created" && targetId) {
      try {
        await browser.Target.closeTarget({ targetId });
      } catch (closeError) {
        const message = closeError instanceof Error ? closeError.message : String(closeError);
        logger(`Failed to close unused remote Chrome tab ${targetId}: ${message}`);
      }
    }
    await browser.close().catch(() => undefined);
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
    const domain = (browser as unknown as Record<string, Record<string, unknown>>)[domainName] as
      | Record<string, unknown>
      | undefined;
    const eventName = (name: string) => `${domainName}.${name}.${sessionId}`;
    return new Proxy((domain ?? {}) as T, {
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

export async function createChromePageTarget(
  port: number,
  logger: BrowserLogger,
  host?: string,
): Promise<string | undefined> {
  const effectiveHost = host ?? "127.0.0.1";
  try {
    const created = (await CDP.New({
      host: effectiveHost,
      port,
      url: "about:blank",
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

export function buildHiddenMacChromeOpenArgs(chromePath: string, chromeArgs: string[]): string[] {
  const lower = chromePath.toLowerCase();
  const bundleMarker = ".app/";
  const bundleIndex = lower.indexOf(bundleMarker);
  const appPath = bundleIndex >= 0 ? chromePath.slice(0, bundleIndex + 4) : chromePath;
  if (!appPath.toLowerCase().endsWith(".app")) {
    throw new Error(
      `Cannot guarantee a hidden macOS launch for Chrome path ${chromePath}; use an .app bundle or --remote-chrome.`,
    );
  }
  return ["-g", "-j", "-n", appPath, "--args", ...chromeArgs];
}

async function launchHiddenMacChrome({
  chromeFlags,
  chromePath,
  userDataDir,
  requestedPort,
  ignoreDefaultFlags,
  captureProcessIdentity,
}: {
  chromeFlags: string[];
  chromePath?: string | null;
  userDataDir: string;
  requestedPort?: number;
  ignoreDefaultFlags?: boolean;
  captureProcessIdentity: typeof captureChromeProcessIdentity;
}): Promise<CapturedChromeLaunch> {
  const resolvedChromePath = chromePath ?? Launcher.getFirstInstallation();
  if (!resolvedChromePath) {
    throw new Error("Chrome is not installed.");
  }
  const port = requestedPort ?? (await reserveLoopbackPort());
  const effectiveFlags = ignoreDefaultFlags
    ? chromeFlags
    : [...Launcher.defaultFlags(), ...chromeFlags];
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    ...effectiveFlags,
    "about:blank",
  ];
  await execFileAsync(
    "/usr/bin/open",
    buildHiddenMacChromeOpenArgs(resolvedChromePath, chromeArgs),
  );
  await waitForDebugPort(port);
  const discovered = await findRunningChromeDebugTargetForProfile(userDataDir);
  if (!discovered || discovered.port !== port) {
    throw new Error(
      `Hidden Chrome started on port ${port}, but its process could not be identified.`,
    );
  }
  const provisionalLauncher = {
    pid: discovered.pid,
    port,
    process: undefined,
    remoteDebuggingPipes: null,
    kill: async () => {
      try {
        process.kill(discovered.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    },
    host: "127.0.0.1",
  } as unknown as LaunchedChrome & { host?: string };
  const processIdentity = await captureLaunchedChromeProcessIdentity(
    userDataDir,
    provisionalLauncher,
    captureProcessIdentity,
  );
  return {
    ...provisionalLauncher,
    processIdentity,
  } as CapturedChromeLaunch;
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port > 0) resolve(port);
        else reject(new Error("Failed to reserve a Chrome debugging port."));
      });
    });
  });
}

async function waitForDebugPort(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for hidden Chrome on port ${port}.`);
}

function buildChromeFlags(
  headless: boolean,
  debugBindAddress?: string | null,
  hideWindow = false,
): string[] {
  const flags = [
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--no-first-run",
    "--safebrowsing-disable-auto-update",
    "--disable-features=TranslateUI,AutomationControlled",
    "--mute-audio",
    "--window-size=1280,720",
    "--lang=en-US",
    "--accept-lang=en-US,en",
  ];

  if (process.platform !== "win32" && !isWsl()) {
    flags.push("--password-store=basic", "--use-mock-keychain");
  }

  if (debugBindAddress) {
    flags.push(`--remote-debugging-address=${debugBindAddress}`);
  }

  if (headless) {
    flags.push("--headless=new");
  } else if (hideWindow && process.platform === "darwin") {
    // Cmd-H stops macOS Chrome from compositing the page, which can swallow
    // trusted CDP clicks and retain the prompt as a draft. Keeping the window
    // off-screen avoids desktop disruption while preserving normal rendering.
    flags.push("--window-position=-32000,-32000");
  }

  // Opt-in only: container/CI Chromium often cannot use the sandbox. Callers must
  // set ORACLE_CHROME_NO_SANDBOX=1 explicitly (never default this on).
  if (process.env.ORACLE_CHROME_NO_SANDBOX === "1") {
    flags.push("--no-sandbox", "--disable-dev-shm-usage");
  }

  return flags;
}

export function buildChromeFlagsForTest(
  headless: boolean,
  debugBindAddress?: string | null,
  hideWindow = false,
): string[] {
  return buildChromeFlags(headless, debugBindAddress, hideWindow);
}

function resolveChromeLaunchOptions(
  chromeFlags: string[],
  usingCopiedProfile: boolean,
): { chromeFlags: string[]; ignoreDefaultFlags: boolean } {
  if (!usingCopiedProfile) {
    return { chromeFlags, ignoreDefaultFlags: false };
  }
  return {
    chromeFlags: [...Launcher.defaultFlags(), ...chromeFlags].filter(
      (flag) => flag !== "--use-mock-keychain" && flag !== "--password-store=basic",
    ),
    ignoreDefaultFlags: true,
  };
}

export function resolveChromeLaunchOptionsForTest(
  chromeFlags: string[],
  usingCopiedProfile: boolean,
): { chromeFlags: string[]; ignoreDefaultFlags: boolean } {
  return resolveChromeLaunchOptions(chromeFlags, usingCopiedProfile);
}

function parseDebugPortEnv(): number | null {
  const raw = process.env.ORACLE_BROWSER_PORT ?? process.env.ORACLE_BROWSER_DEBUG_PORT;
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) {
    return null;
  }
  return value;
}

async function launchWithCustomHost({
  chromeFlags,
  chromePath,
  userDataDir,
  host,
  requestedPort,
  ignoreDefaultFlags,
}: {
  chromeFlags: string[];
  chromePath?: string | null;
  userDataDir: string;
  host: string | null;
  requestedPort?: number;
  ignoreDefaultFlags?: boolean;
}): Promise<LaunchedChrome & { host?: string }> {
  const launcher = new Launcher({
    chromePath: chromePath ?? undefined,
    chromeFlags,
    userDataDir,
    handleSIGINT: false,
    port: requestedPort ?? undefined,
    ignoreDefaultFlags,
  });

  if (host) {
    const patched = launcher as unknown as { isDebuggerReady?: () => Promise<void>; port?: number };
    patched.isDebuggerReady = function patchedIsDebuggerReady(
      this: Launcher & { port?: number },
    ): Promise<void> {
      const debugPort = this.port ?? 0;
      if (!debugPort) {
        return Promise.reject(new Error("Missing Chrome debug port"));
      }
      return new Promise((resolve, reject) => {
        const client = net.createConnection({ port: debugPort, host });
        const cleanup = () => {
          client.removeAllListeners();
          client.end();
          client.destroy();
          client.unref();
        };
        client.once("error", (err) => {
          cleanup();
          reject(err);
        });
        client.once("connect", () => {
          cleanup();
          resolve();
        });
      });
    };
  }

  await launcher.launch();

  const kill = async () => launcher.kill();
  return {
    pid: launcher.pid ?? undefined,
    port: launcher.port ?? 0,
    process: launcher.chromeProcess as unknown as NonNullable<LaunchedChrome["process"]>,
    kill,
    host: host ?? undefined,
    remoteDebuggingPipes: launcher.remoteDebuggingPipes,
  } as unknown as LaunchedChrome & { host?: string };
}
