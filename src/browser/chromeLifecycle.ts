import { mkdir, rm } from "node:fs/promises";
import { closeSync, openSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import CDP from "chrome-remote-interface";
import { launch, Launcher, type LaunchedChrome } from "chrome-launcher";
import type { BrowserLogger, ResolvedBrowserConfig, ChromeClient } from "./types.js";
import { normalizeLocalChromeLaunchConfig } from "./config.js";
import { cleanupStaleProfileState } from "./profileState.js";
import { delay } from "./utils.js";
import { launchCarbonyl } from "./carbonylLifecycle.js";

const execFileAsync = promisify(execFile);
const DEFAULT_FOCUS_GUARD_WINDOW_MS: number | null = null;
const DEFAULT_CHROME_LAUNCH_TIMEOUT_MS = 30_000;
const DEFAULT_CHROME_LAUNCH_POLL_MS = 250;
const DEFAULT_CDP_CONNECT_TIMEOUT_MS = 15_000;

async function withCdpConnectTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export interface FrontmostProcessTarget {
  name: string;
  pid?: number | null;
}

export async function launchChrome(
  config: ResolvedBrowserConfig,
  userDataDir: string,
  logger: BrowserLogger,
) {
  const effectiveConfig = normalizeLocalChromeLaunchConfig(config);
  const connectHost = resolveRemoteDebugHost();
  const debugBindAddress = connectHost && connectHost !== "127.0.0.1" ? "0.0.0.0" : connectHost;
  const debugPort = effectiveConfig.debugPort ?? parseDebugPortEnv();
  const backgroundLaunch = shouldUseMacOsBackgroundLaunch(effectiveConfig);
  const chromeFlags = buildChromeFlags(effectiveConfig.headless ?? false, debugBindAddress, {
    startWithoutWindow: backgroundLaunch,
  });
  if (effectiveConfig.launcher === "carbonyl") {
    return launchCarbonyl(
      {
        chromePath: effectiveConfig.chromePath,
        chromeFlags,
        debugPort,
        host: connectHost ?? "127.0.0.1",
        // Keep Carbonyl aligned with the normal Chrome path: start on a blank page,
        // then let Oracle seed cookies and navigate to ChatGPT explicitly.
        url: "about:blank",
        userDataDir,
      },
      logger,
    );
  }
  const usePatchedLauncher = Boolean(connectHost && connectHost !== "127.0.0.1");
  const launcher = backgroundLaunch
    ? await launchBackgroundChromeOnMac({
        chromeFlags,
        chromePath: effectiveConfig.chromePath ?? undefined,
        userDataDir,
        host: connectHost ?? "127.0.0.1",
        requestedPort: debugPort ?? undefined,
      })
    : usePatchedLauncher
      ? await launchWithCustomHost({
          chromeFlags,
          chromePath: effectiveConfig.chromePath ?? undefined,
          userDataDir,
          host: connectHost ?? "127.0.0.1",
          requestedPort: debugPort ?? undefined,
        })
      : await launch({
          chromePath: effectiveConfig.chromePath ?? undefined,
          chromeFlags,
          userDataDir,
          handleSIGINT: false,
          port: debugPort ?? undefined,
        });
  const pidLabel = typeof launcher.pid === "number" ? ` (pid ${launcher.pid})` : "";
  const hostLabel = connectHost ? ` on ${connectHost}` : "";
  logger(`Launched Chrome${pidLabel} on port ${launcher.port}${hostLabel}`);
  return Object.assign(launcher, { host: connectHost ?? "127.0.0.1" }) as LaunchedChrome & {
    host?: string;
  };
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
    const leaveRunning = keepBrowser || inFlight;
    if (leaveRunning) {
      logger(
        `Received ${signal}; leaving Chrome running${inFlight ? " (assistant response pending)" : ""}`,
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

export async function hideChromeWindow(
  chrome: LaunchedChrome,
  logger: BrowserLogger,
  restoreTarget?: FrontmostProcessTarget | string | null,
): Promise<void> {
  if (process.platform !== "darwin") {
    logger("Window hiding is only supported on macOS");
    return;
  }
  if (!chrome.pid) {
    logger("Unable to hide window: missing Chrome PID");
    return;
  }
  const normalizedRestoreTarget = normalizeRestorableTarget(restoreTarget);
  const shouldRestore = normalizedRestoreTarget
    ? await isProcessFrontmost(chrome.pid, logger)
    : false;
  const script = `tell application "System Events"
    try
      set visible of (first process whose unix id is ${chrome.pid}) to false
    end try
  end tell`;
  try {
    await execFileAsync("osascript", ["-e", script]);
    logger("Chrome window hidden (Cmd-H)");
    if (shouldRestore && normalizedRestoreTarget) {
      await restoreFrontmostApplication(normalizedRestoreTarget, logger);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to hide Chrome window: ${message}`);
  }
}

export async function captureFrontmostProcess(
  logger: BrowserLogger,
): Promise<FrontmostProcessTarget | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      `tell application "System Events"
        try
          set frontProcess to first application process whose frontmost is true
          return (name of frontProcess as text) & linefeed & (unix id of frontProcess as text)
        on error
          return ""
        end try
      end tell`,
    ]);
    const [rawName = "", rawPid = ""] = stdout
      .split(/\r?\n/)
      .map((part) => part.trim())
      .filter((part, index) => index === 0 || part.length > 0);
    const name = rawName.trim();
    if (!name) {
      return null;
    }
    const parsedPid = Number.parseInt(rawPid, 10);
    return {
      name,
      pid: Number.isFinite(parsedPid) && parsedPid > 0 ? parsedPid : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to capture frontmost application: ${message}`);
    return null;
  }
}

async function isProcessFrontmost(pid: number, logger: BrowserLogger): Promise<boolean> {
  const frontmost = await captureFrontmostProcess(logger);
  return matchesChromeProcess(frontmost, pid);
}

export function startChromeFocusGuard(
  chrome: LaunchedChrome,
  logger: BrowserLogger,
  restoreTargetInput?: FrontmostProcessTarget | string | null,
  intervalMs = 250,
  maxDurationMs: number | null = DEFAULT_FOCUS_GUARD_WINDOW_MS,
): () => void {
  if (process.platform !== "darwin" || !chrome.pid) {
    return () => {};
  }
  if (typeof maxDurationMs === "number" && maxDurationMs <= 0) {
    return () => {};
  }

  let stopped = false;
  let inFlight = false;
  let restoreTarget = normalizeRestorableTarget(restoreTargetInput);
  const deadline =
    typeof maxDurationMs === "number" && Number.isFinite(maxDurationMs)
      ? Date.now() + maxDurationMs
      : null;
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
  const tick = async () => {
    if (stopped || inFlight) {
      return;
    }
    if (deadline !== null && Date.now() >= deadline) {
      stop();
      return;
    }
    inFlight = true;
    try {
      const frontmost = await captureFrontmostProcess(logger);
      const targetIsFrontmost = matchesChromeProcess(frontmost, chrome.pid);
      if (!targetIsFrontmost) {
        const latestRestoreTarget = normalizeRestorableTarget(frontmost);
        if (latestRestoreTarget && !isChromeProcessName(latestRestoreTarget.name)) {
          restoreTarget = latestRestoreTarget;
        }
      }
      if (targetIsFrontmost) {
        await hideChromeWindow(chrome, logger, restoreTarget);
      }
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  return stop;
}

export async function finalizeChromeFocusProtection(
  chrome: LaunchedChrome,
  logger: BrowserLogger,
  stopFocusGuard: (() => void) | null | undefined,
  restoreTarget?: FrontmostProcessTarget | string | null,
): Promise<void> {
  try {
    await hideChromeWindow(chrome, logger, restoreTarget).catch(() => undefined);
  } finally {
    stopFocusGuard?.();
  }
}

async function restoreFrontmostApplication(
  restoreTarget: FrontmostProcessTarget | string,
  logger: BrowserLogger,
): Promise<void> {
  const normalized = normalizeRestorableTarget(restoreTarget);
  if (!normalized) {
    return;
  }
  if (normalized.pid && normalized.pid > 0) {
    try {
      await execFileAsync("osascript", [
        "-e",
        `tell application "System Events"
          try
            set frontmost of (first application process whose unix id is ${normalized.pid}) to true
          on error
            return
          end try
        end tell`,
      ]);
      logger(`Restored focus to ${normalized.name}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to restore focus to ${normalized.name}: ${message}`);
    }
  }
  const escaped = normalized.name.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  try {
    await execFileAsync("osascript", ["-e", `tell application "${escaped}" to activate`]);
    logger(`Restored focus to ${normalized.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to restore focus to ${normalized.name}: ${message}`);
  }
}

function normalizeRestorableTarget(
  target?: FrontmostProcessTarget | string | null,
): FrontmostProcessTarget | null {
  if (typeof target === "string") {
    const name = target.trim();
    if (!name || isChromeProcessName(name)) {
      return null;
    }
    return { name, pid: null };
  }
  const name = target?.name?.trim();
  if (!name || isChromeProcessName(name)) {
    return null;
  }
  const pid = target?.pid;
  return {
    name,
    pid: typeof pid === "number" && Number.isFinite(pid) && pid > 0 ? pid : null,
  };
}

function matchesChromeProcess(
  processTarget: FrontmostProcessTarget | null | undefined,
  pid: number | null | undefined,
): boolean {
  if (!Number.isFinite(pid) || (pid ?? 0) <= 0) {
    return false;
  }
  return processTarget?.pid === pid;
}

function isChromeProcessName(name?: string | null): boolean {
  const normalized = name?.trim().toLowerCase();
  return normalized === "google chrome" || normalized === "chromium";
}

export async function connectToChrome(
  port: number,
  logger: BrowserLogger,
  host?: string,
): Promise<ChromeClient> {
  const effectiveHost = host ?? "127.0.0.1";
  const client = await withCdpConnectTimeout(
    CDP({ port, host: effectiveHost }) as Promise<ChromeClient>,
    DEFAULT_CDP_CONNECT_TIMEOUT_MS,
    `Timed out connecting to Chrome DevTools at ${effectiveHost}:${port}.`,
  );
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
    closeTargetOnDispose?: boolean;
  },
): Promise<RemoteChromeConnection> {
  const closeTargetOnDispose = options?.closeTargetOnDispose ?? true;
  if (browserWSEndpoint) {
    return await connectToRemoteChromeTarget(host, port, logger, {
      browserWSEndpoint,
      targetUrl: targetUrl ?? "about:blank",
      closeTargetOnDispose,
      approvalWaitMs: options?.approvalWaitMs,
    });
  }
  if (targetUrl) {
    const targetConnection = await connectToNewTarget(host, port, targetUrl, logger, {
      opened: () => `Opened dedicated remote Chrome tab targeting ${targetUrl}`,
      openFailed: (message) =>
        `Failed to open dedicated remote Chrome tab (${message}); falling back to first target.`,
      attachFailed: (targetId, message) =>
        `Failed to attach to dedicated remote Chrome tab ${targetId} (${message}); falling back to first target.`,
      closeFailed: (targetId, message) =>
        `Failed to close unused remote Chrome tab ${targetId}: ${message}`,
    });
    if (targetConnection) {
      return {
        client: targetConnection.client,
        targetId: targetConnection.targetId,
        close: async () => {
          await targetConnection.client.close().catch(() => undefined);
          if (closeTargetOnDispose) {
            await closeRemoteChromeTarget(host, port, targetConnection.targetId, logger);
          }
        },
      };
    }
  }
  const fallbackClient = await CDP({ host, port });
  logger(`Connected to remote Chrome DevTools protocol at ${host}:${port}`);
  return {
    client: fallbackClient,
    close: async () => {
      await fallbackClient.close().catch(() => undefined);
    },
  };
}

export async function closeRemoteChromeTarget(
  host: string,
  port: number,
  targetId: string | undefined,
  logger: BrowserLogger,
): Promise<void> {
  if (!targetId) {
    return;
  }
  try {
    await CDP.Close({ host, port, id: targetId });
    if (logger.verbose) {
      logger(`Closed remote Chrome tab ${targetId}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to close remote Chrome tab ${targetId}: ${message}`);
  }
}

export interface RemoteChromeConnection {
  client: ChromeClient;
  targetId?: string;
  browserWSEndpoint?: string;
  close: () => Promise<void>;
}

export interface IsolatedTabConnection {
  client: ChromeClient;
  targetId?: string;
  browserWSEndpoint?: string;
}

interface TargetConnectMessages {
  opened?: (targetId: string) => string;
  openFailed: (message: string) => string;
  attachFailed: (targetId: string, message: string) => string;
  closeFailed: (targetId: string, message: string) => string;
}

export interface RemoteTargetInfo {
  targetId?: string;
  id?: string;
  type?: string;
  url?: string;
}

interface BrowserVersionInfo {
  webSocketDebuggerUrl?: string;
}

function normalizeRemoteTargetInfo(target: RemoteTargetInfo): RemoteTargetInfo {
  return {
    ...target,
    targetId: target.targetId ?? target.id,
  };
}

async function getBrowserWebSocketDebuggerUrl(
  host: string,
  port: number,
): Promise<string | undefined> {
  const response = await fetch(`http://${host}:${port}/json/version`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const version = (await response.json()) as BrowserVersionInfo;
  return typeof version.webSocketDebuggerUrl === "string"
    ? version.webSocketDebuggerUrl
    : undefined;
}

export async function listRemoteChromeTargets(options: {
  host: string;
  port: number;
  browserWSEndpoint?: string;
}): Promise<RemoteTargetInfo[]> {
  if (!options.browserWSEndpoint) {
    const targets = await CDP.List({ host: options.host, port: options.port });
    return (targets as unknown as RemoteTargetInfo[]).map(normalizeRemoteTargetInfo);
  }
  const browser = await withCdpConnectTimeout(
    CDP({ target: options.browserWSEndpoint, local: true }) as Promise<ChromeClient>,
    DEFAULT_CDP_CONNECT_TIMEOUT_MS,
    `Timed out connecting to Chrome DevTools browser websocket at ${options.host}:${options.port} while listing targets.`,
  );
  try {
    const result = await browser.Target.getTargets();
    return (result.targetInfos ?? []).map((target) =>
      normalizeRemoteTargetInfo({
        targetId: target.targetId,
        type: target.type,
        url: target.url,
      }),
    );
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
    createTargetOptions?: {
      background?: boolean;
      hidden?: boolean;
      focus?: boolean;
    };
  },
): Promise<RemoteChromeConnection> {
  if (!options.browserWSEndpoint) {
    const targetLabel = options.targetId ?? "default";
    const client = await withCdpConnectTimeout(
      CDP({ host, port, target: options.targetId }) as Promise<ChromeClient>,
      DEFAULT_CDP_CONNECT_TIMEOUT_MS,
      `Timed out connecting to Chrome DevTools target ${targetLabel} at ${host}:${port}.`,
    );
    return {
      client,
      targetId: options.targetId,
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
  let targetId = options.targetId;
  try {
    if (!targetId) {
      const created = await withCdpConnectTimeout(
        browser.Target.createTarget({
          url: options.targetUrl ?? "about:blank",
          ...options.createTargetOptions,
        }),
        DEFAULT_CDP_CONNECT_TIMEOUT_MS,
        `Timed out creating a remote Chrome target at ${host}:${port}.`,
      );
      targetId = created.targetId;
      logger(`Opened dedicated remote Chrome tab targeting ${options.targetUrl ?? "about:blank"}`);
    }
    if (targetId && typeof browser.Target.getTargetInfo === "function") {
      try {
        const targetInfo = await withCdpConnectTimeout(
          browser.Target.getTargetInfo({ targetId }),
          DEFAULT_CDP_CONNECT_TIMEOUT_MS,
          `Timed out verifying remote Chrome target ${targetId} at ${host}:${port}.`,
        );
        if (!targetInfo?.targetInfo) {
          throw new Error("missing target info");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Remote Chrome target ${targetId} is unavailable: ${message}`);
      }
    }
    const attached = await withCdpConnectTimeout(
      browser.Target.attachToTarget({ targetId, flatten: true }),
      DEFAULT_CDP_CONNECT_TIMEOUT_MS,
      `Timed out attaching to remote Chrome target ${targetId ?? "unknown"} at ${host}:${port}.`,
    );
    const client = createSessionBoundChromeClient(browser, attached.sessionId);
    return {
      client,
      targetId,
      browserWSEndpoint: options.browserWSEndpoint,
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
  const connectPromise = CDP({ target: browserWSEndpoint, local: true }) as Promise<ChromeClient>;
  const timeoutMs =
    approvalWaitMs && approvalWaitMs > 0 ? approvalWaitMs : DEFAULT_CDP_CONNECT_TIMEOUT_MS;
  if (!approvalWaitMs || approvalWaitMs <= 0) {
    return await withCdpConnectTimeout(
      connectPromise,
      timeoutMs,
      `Timed out connecting to Chrome DevTools browser websocket at ${host}:${port}.`,
    );
  }

  logger(`Waiting for Chrome remote debugging approval for ${host}:${port}...`);

  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      connectPromise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              `Oracle waited ${formatApprovalWait(timeoutMs)} for Chrome remote debugging approval at ${host}:${port}. Allow the Chrome prompt or retry after toggling remote debugging.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
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
    Network: bindDomain("Network"),
    Page: bindDomain("Page"),
    Runtime: bindDomain("Runtime"),
    Input: bindDomain("Input"),
    DOM: bindDomain("DOM"),
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

function withConnectionClose(client: ChromeClient, close: () => Promise<void>): ChromeClient {
  return Object.assign(client, {
    close,
  });
}

export async function connectWithNewTab(
  port: number,
  logger: BrowserLogger,
  initialUrl?: string,
  host?: string,
  options?: {
    fallbackToDefault?: boolean;
    retries?: number;
    retryDelayMs?: number;
    preferDefaultTarget?: boolean;
    hiddenTarget?: boolean;
    closeTargetOnDispose?: boolean;
  },
): Promise<IsolatedTabConnection> {
  const effectiveHost = host ?? "127.0.0.1";
  const url = initialUrl ?? "about:blank";
  const closeTargetOnDispose = options?.closeTargetOnDispose ?? true;
  if (options?.hiddenTarget) {
    const failClosed = (message: string) =>
      new Error(
        `Failed to open hidden browser target (${message}); refusing to attach to a visible target.`,
      );
    try {
      const browserWSEndpoint = await getBrowserWebSocketDebuggerUrl(effectiveHost, port);
      if (!browserWSEndpoint) {
        throw new Error("missing browser websocket endpoint");
      }
      logger("Opening hidden browser target via browser websocket endpoint.");
      let connection: RemoteChromeConnection;
      try {
        connection = await connectToRemoteChromeTarget(effectiveHost, port, logger, {
          browserWSEndpoint,
          targetUrl: url,
          closeTargetOnDispose,
          createTargetOptions: {
            background: true,
            hidden: true,
            focus: false,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("hidden target")) {
          throw failClosed(message);
        }
        logger(
          `Hidden browser target unsupported (${message}); retrying with a dedicated background target in the Oracle hidden browser.`,
        );
        try {
          connection = await connectToRemoteChromeTarget(effectiveHost, port, logger, {
            browserWSEndpoint,
            targetUrl: url,
            closeTargetOnDispose,
            createTargetOptions: {
              background: true,
              focus: false,
            },
          });
        } catch (fallbackError) {
          const fallbackMessage =
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          throw failClosed(`${message}; background target retry failed: ${fallbackMessage}`);
        }
      }
      return {
        client: withConnectionClose(connection.client, connection.close),
        targetId: connection.targetId,
        browserWSEndpoint: connection.browserWSEndpoint,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw failClosed(message);
    }
  }
  if (options?.preferDefaultTarget) {
    logger("Skipping isolated browser tab creation; attaching to the default target.");
    try {
      const browserWSEndpoint = await getBrowserWebSocketDebuggerUrl(effectiveHost, port);
      if (browserWSEndpoint) {
        const targets = await listRemoteChromeTargets({
          host: effectiveHost,
          port,
          browserWSEndpoint,
        });
        const target =
          targets.find((candidate) => candidate.type === "page") ??
          targets.find((candidate) => candidate.targetId);
        const connection = await connectToRemoteChromeTarget(effectiveHost, port, logger, {
          browserWSEndpoint,
          targetId: target?.targetId,
          closeTargetOnDispose: false,
        });
        return {
          client: withConnectionClose(connection.client, connection.close),
          targetId: connection.targetId,
          browserWSEndpoint: connection.browserWSEndpoint,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Default-target browser websocket attach unavailable (${message}); using direct CDP.`);
    }
    const client = await connectToChrome(port, logger, effectiveHost);
    return { client };
  }
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
      const baseClose =
        typeof targetConnection.client.close === "function"
          ? targetConnection.client.close.bind(targetConnection.client)
          : async () => undefined;
      return {
        client: withConnectionClose(targetConnection.client, async () => {
          await baseClose().catch(() => undefined);
          if (closeTargetOnDispose) {
            await closeRemoteChromeTarget(effectiveHost, port, targetConnection.targetId, logger);
          }
        }),
        targetId: targetConnection.targetId,
      };
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
): Promise<void> {
  const effectiveHost = host ?? "127.0.0.1";
  try {
    await CDP.Close({ host: effectiveHost, port, id: targetId });
    logger(`Closed isolated browser tab (target=${targetId})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to close browser tab ${targetId}: ${message}`);
  }
}

function buildChromeFlags(
  headless: boolean,
  debugBindAddress?: string | null,
  options?: {
    startWithoutWindow?: boolean;
  },
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
  }

  if (options?.startWithoutWindow) {
    flags.push("--no-startup-window");
  }

  return flags;
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

function resolveRemoteDebugHost(): string | null {
  const override =
    process.env.ORACLE_BROWSER_REMOTE_DEBUG_HOST?.trim() || process.env.WSL_HOST_IP?.trim();
  if (override) {
    return override;
  }
  if (!isWsl()) {
    return null;
  }
  try {
    const resolv = readFileSync("/etc/resolv.conf", "utf8");
    for (const line of resolv.split("\n")) {
      const match = line.match(/^nameserver\s+([0-9.]+)/);
      if (match?.[1]) {
        return match[1];
      }
    }
  } catch {
    // ignore; fall back to localhost
  }
  return null;
}

function isWsl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  if (process.env.WSL_DISTRO_NAME) {
    return true;
  }
  const release = os.release();
  return release.toLowerCase().includes("microsoft");
}

async function launchWithCustomHost({
  chromeFlags,
  chromePath,
  userDataDir,
  host,
  requestedPort,
}: {
  chromeFlags: string[];
  chromePath?: string | null;
  userDataDir: string;
  host: string | null;
  requestedPort?: number;
}): Promise<LaunchedChrome & { host?: string }> {
  const launcher = new Launcher({
    chromePath: chromePath ?? undefined,
    chromeFlags,
    userDataDir,
    handleSIGINT: false,
    port: requestedPort ?? undefined,
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

function shouldUseMacOsBackgroundLaunch(config: ResolvedBrowserConfig): boolean {
  return process.platform === "darwin" && !config.headless && config.hideWindow;
}

async function launchBackgroundChromeOnMac({
  chromeFlags,
  chromePath,
  userDataDir,
  host,
  requestedPort,
}: {
  chromeFlags: string[];
  chromePath?: string | null;
  userDataDir: string;
  host: string;
  requestedPort?: number;
}): Promise<LaunchedChrome & { host?: string }> {
  const port = await reserveDevToolsPort(requestedPort);
  const chromeBinary = resolveMacChromeExecutable(chromePath);
  await mkdir(userDataDir, { recursive: true });
  const outPath = path.join(userDataDir, "chrome-out.log");
  const errPath = path.join(userDataDir, "chrome-err.log");
  const launchArgs = [
    ...Launcher.defaultFlags(),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    ...chromeFlags,
  ];
  const stdoutFd = openSync(outPath, "a");
  const stderrFd = openSync(errPath, "a");
  let launchedPid: number | null = null;
  try {
    const chrome = spawn(chromeBinary, launchArgs, {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    chrome.unref();
    launchedPid = typeof chrome.pid === "number" && chrome.pid > 0 ? chrome.pid : null;
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }

  const pid = await waitForBackgroundChromeLaunch({
    host,
    port,
    userDataDir,
    fallbackPid: launchedPid,
  });

  const kill = async () => {
    if (pid) {
      await terminateChromeProcess(pid);
    }
  };

  return {
    pid: pid ?? undefined,
    port,
    process: undefined as unknown as NonNullable<LaunchedChrome["process"]>,
    kill,
    host,
    remoteDebuggingPipes: false,
  } as unknown as LaunchedChrome & { host?: string };
}

function resolveMacChromeExecutable(chromePath?: string | null): string {
  const resolved = chromePath?.trim() || Launcher.getFirstInstallation();
  if (!resolved) {
    throw new Error("Chrome is not installed");
  }
  if (!resolved.endsWith(".app")) {
    return resolved;
  }
  const macOsDir = path.join(resolved, "Contents", "MacOS");
  const bundleName = path.basename(resolved, ".app");
  const entries = readdirSync(macOsDir, { withFileTypes: true }).filter((entry) => entry.isFile());
  const executable =
    entries.find((entry) => entry.name === bundleName) ??
    entries.find((entry) => !entry.name.startsWith(".")) ??
    null;
  if (!executable) {
    throw new Error(`Unable to locate a Chrome executable inside ${resolved}`);
  }
  return path.join(macOsDir, executable.name);
}

async function reserveDevToolsPort(preferred?: number): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      server.close(() => undefined);
      reject(error);
    });
    server.listen(preferred ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate a Chrome DevTools port.")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForBackgroundChromeLaunch({
  host,
  port,
  userDataDir,
  fallbackPid = null,
  timeoutMs = DEFAULT_CHROME_LAUNCH_TIMEOUT_MS,
}: {
  host: string;
  port: number;
  userDataDir: string;
  fallbackPid?: number | null;
  timeoutMs?: number;
}): Promise<number | null> {
  const startedAt = Date.now();
  let detectedPid: number | null = fallbackPid;
  while (Date.now() - startedAt < timeoutMs) {
    const [debugReady, pidByPort, pidByProfile] = await Promise.all([
      isDebuggerReady(host, port),
      findPidListeningOnPort(port),
      findChromePidByUserDataDir(userDataDir),
    ]);
    detectedPid = pidByPort ?? pidByProfile ?? detectedPid;
    if (debugReady) {
      return detectedPid;
    }
    await delay(DEFAULT_CHROME_LAUNCH_POLL_MS);
  }
  throw new Error(`timed out waiting for hidden Chrome DevTools on ${host}:${port}`);
}

async function isDebuggerReady(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const client = net.createConnection({ host, port });
    const finish = (ready: boolean) => {
      client.removeAllListeners();
      client.end();
      client.destroy();
      client.unref();
      resolve(ready);
    };
    client.once("error", () => finish(false));
    client.once("connect", () => finish(true));
  });
}

async function findPidListeningOnPort(port: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    return parsePidFromText(stdout);
  } catch {
    return null;
  }
}

async function findChromePidByUserDataDir(userDataDir: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axww", "-o", "pid=,command="]);
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!match) {
        continue;
      }
      const pid = Number.parseInt(match[1] ?? "", 10);
      const command = match[2] ?? "";
      if (!Number.isFinite(pid) || pid <= 0) {
        continue;
      }
      if (
        command.includes(`--user-data-dir=${userDataDir}`) &&
        command.includes("--remote-debugging-port=")
      ) {
        return pid;
      }
    }
  } catch {
    // ignore process-list failures and fall back to the DevTools port probe
  }
  return null;
}

function parsePidFromText(stdout: string): number | null {
  const match = stdout.trim().match(/^(\d+)/);
  if (!match) {
    return null;
  }
  const pid = Number.parseInt(match[1], 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

async function terminateChromeProcess(pid: number): Promise<void> {
  if (!(await isProcessRunning(pid))) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!isNoSuchProcessError(error)) {
      throw error;
    }
    return;
  }
  const exitedAfterTerm = await waitForProcessExit(pid, 2_000);
  if (exitedAfterTerm) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!isNoSuchProcessError(error)) {
      throw error;
    }
  }
  await waitForProcessExit(pid, 1_000);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await isProcessRunning(pid))) {
      return true;
    }
    await delay(100);
  }
  return !(await isProcessRunning(pid));
}

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcessError(error)) {
      return false;
    }
    throw error;
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ESRCH" ||
      (error as NodeJS.ErrnoException).code === "ENOENT")
  );
}
