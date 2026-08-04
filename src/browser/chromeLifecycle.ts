import net from "node:net";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { promisify } from "node:util";
import CDP from "chrome-remote-interface";
import { launch, Launcher, type LaunchedChrome } from "chrome-launcher";
import type { BrowserLogger, ResolvedBrowserConfig, ChromeClient } from "./types.js";
import {
  assertProfileDirectoryIdentity,
  captureChromeProcessIdentity,
  captureProfileDirectoryIdentity,
  cleanupStaleProfileState,
  findRunningChromeProcessForProfile,
  getDevToolsActivePortPaths,
  inspectChromeProcessIdentity,
  isSafeChromeTerminationOutcome,
  removeProfileDirectoryIfIdentityMatches,
  sameProfileDirectoryIdentity,
  writeOracleChromeOwner,
  type ChromeProcessIdentity,
  type ChromeProcessIdentityInspection,
  type OracleChromeOwnerRecord,
  type ProfileDirectoryIdentity,
  type RecordedChromeTerminationOutcome,
} from "./profileState.js";
import { delay } from "./utils.js";
import { isWsl, resolveWslChromeLaunchRoute } from "./wslHost.js";
const execFileAsync = promisify(execFile);

export type ChromeStableKill = () => Promise<RecordedChromeTerminationOutcome>;

export interface StableChromeProcessHandle {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
  removeListener(event: "exit", listener: () => void): unknown;
  unref?(): void;
}

export interface ChromeLaunchResult {
  readonly pid: number;
  readonly port: number;
  readonly process?: StableChromeProcessHandle;
  readonly remoteDebuggingPipes: LaunchedChrome["remoteDebuggingPipes"];
  readonly host?: string;
  readonly kill: ChromeStableKill;
  readonly processIdentity: ChromeProcessIdentity;
}

interface StableChromeLauncher {
  readonly pid?: number;
  readonly port: number;
  readonly process?: StableChromeProcessHandle;
  readonly remoteDebuggingPipes: LaunchedChrome["remoteDebuggingPipes"];
  readonly kill: ChromeStableKill;
  readonly host?: string;
  readonly processIdentity?: ChromeProcessIdentity;
}

export interface ChromeLaunchDeps {
  platform?: NodeJS.Platform;
  standardLaunch?: typeof launch;
  customHostLaunch?: typeof launchWithCustomHost;
  hiddenMacLaunch?: typeof launchHiddenMacChrome;
  resolveLaunchRoute?: typeof resolveWslChromeLaunchRoute;
  captureProcessIdentity?: typeof captureChromeProcessIdentity;
  captureProfileIdentity?: typeof captureProfileDirectoryIdentity;
  writeOwner?: typeof writeOracleChromeOwner;
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
  const profileDirectory = await (deps.captureProfileIdentity ?? captureProfileDirectoryIdentity)(
    userDataDir,
    { create: true },
  );
  const launchUserDataDir = profileDirectory.canonicalPath;
  const debugPort = config.debugPort ?? parseDebugPortEnv();
  const chromeFlags = buildChromeFlags(
    config.headless ?? false,
    debugBindAddress,
    config.hideWindow ?? false,
  );
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

  let launcher: StableChromeLauncher;
  if (hiddenHeadfulLaunch) {
    launcher = await (deps.hiddenMacLaunch ?? launchHiddenMacChrome)({
      chromeFlags: launchOptions.chromeFlags,
      chromePath: config.chromePath ?? undefined,
      userDataDir: launchUserDataDir,
      requestedPort: debugPort ?? undefined,
      ignoreDefaultFlags: launchOptions.ignoreDefaultFlags,
      captureProcessIdentity: deps.captureProcessIdentity ?? captureChromeProcessIdentity,
      expectedProfileDirectory: profileDirectory,
    });
  } else {
    const launched = usePatchedLauncher
      ? await (deps.customHostLaunch ?? launchWithCustomHost)({
          chromeFlags: launchOptions.chromeFlags,
          chromePath: config.chromePath ?? undefined,
          userDataDir: launchUserDataDir,
          host: connectHost ?? "127.0.0.1",
          requestedPort: debugPort ?? undefined,
          ignoreDefaultFlags: launchOptions.ignoreDefaultFlags,
        })
      : Object.assign(
          await (deps.standardLaunch ?? launch)({
            chromePath: config.chromePath ?? undefined,
            chromeFlags: launchOptions.chromeFlags,
            userDataDir: launchUserDataDir,
            handleSIGINT: false,
            port: debugPort ?? undefined,
            ignoreDefaultFlags: launchOptions.ignoreDefaultFlags,
          }),
          { host: "127.0.0.1" },
        );
    if (!launched.process) {
      throw new Error(
        `Launched Chrome for ${launchUserDataDir} did not expose a retained process handle; refusing PID-based lifecycle authority.`,
      );
    }
    const retainedProcess = retainChromeChildProcess(launched.process);
    launcher = {
      pid: launched.pid,
      port: launched.port,
      process: retainedProcess,
      remoteDebuggingPipes: launched.remoteDebuggingPipes,
      host: launched.host,
      kill: createStableChildProcessChromeKill(retainedProcess),
    };
  }

  const processIdentity =
    launcher.processIdentity ??
    (await captureLaunchedChromeProcessIdentity(
      launchUserDataDir,
      launcher,
      profileDirectory,
      deps.captureProcessIdentity ?? captureChromeProcessIdentity,
    ));
  if (!sameProfileDirectoryIdentity(processIdentity.profileDirectory, profileDirectory)) {
    const mismatch = new Error(
      `Physical Chrome profile authority changed during launch: ${launchUserDataDir}`,
    );
    const rollback = await launcher.kill();
    if (!isSafeChromeTerminationOutcome(rollback)) {
      throw new AggregateError(
        [mismatch, new Error(rollback.reason)],
        `Chrome profile authority changed during launch, and safe rollback was unavailable.`,
      );
    }
    throw mismatch;
  }
  const kill = await createOwnerBoundChromeKill(
    launchUserDataDir,
    { port: launcher.port, processIdentity },
    launcher.kill,
    { writeOwner: deps.writeOwner },
  );
  if (typeof launcher.pid !== "number") {
    throw new Error(`Launched Chrome for ${launchUserDataDir} did not retain a process id.`);
  }
  const pidLabel = ` (pid ${launcher.pid})`;
  const hostLabel = connectHost ? ` on ${connectHost}` : "";
  logger(
    `${hiddenHeadfulLaunch ? "Launched hidden background Chrome" : "Launched Chrome"}${pidLabel} on port ${launcher.port}${hostLabel}`,
  );
  return {
    pid: launcher.pid,
    port: launcher.port,
    process: launcher.process,
    remoteDebuggingPipes: launcher.remoteDebuggingPipes,
    host: connectHost ?? "127.0.0.1",
    processIdentity,
    kill,
  };
}

async function captureLaunchedChromeProcessIdentity(
  userDataDir: string,
  launcher: StableChromeLauncher,
  expectedProfileDirectory: ProfileDirectoryIdentity,
  capture: typeof captureChromeProcessIdentity,
): Promise<ChromeProcessIdentity> {
  const pid = launcher.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    const identityError = new Error(
      `Launched Chrome for ${userDataDir} did not report a valid process id.`,
    );
    const rollback = await launcher.kill();
    if (!isSafeChromeTerminationOutcome(rollback)) {
      throw new AggregateError(
        [identityError, new Error(rollback.reason)],
        `Launched Chrome did not report a valid process id, and safe launch rollback was unavailable.`,
      );
    }
    throw identityError;
  }
  try {
    const identity = await capture(userDataDir, pid);
    if (!sameProfileDirectoryIdentity(identity.profileDirectory, expectedProfileDirectory)) {
      throw new Error(`Physical profile authority changed while capturing Chrome identity.`);
    }
    return identity;
  } catch (error) {
    const rollback = await launcher.kill();
    if (!isSafeChromeTerminationOutcome(rollback)) {
      throw new AggregateError(
        [error, new Error(rollback.reason)],
        `Failed to capture Chrome process identity, and safe launch rollback was unavailable.`,
      );
    }
    throw new Error(`Failed to capture Chrome process identity for ${userDataDir}.`, {
      cause: error,
    });
  }
}

export async function createOwnerBoundChromeKill(
  userDataDir: string,
  owner: OracleChromeOwnerRecord,
  stableKill: ChromeStableKill,
  deps: { writeOwner?: typeof writeOracleChromeOwner } = {},
): Promise<ChromeStableKill> {
  try {
    await (deps.writeOwner ?? writeOracleChromeOwner)(userDataDir, owner);
  } catch (error) {
    const rollback = await stableKill();
    if (!isSafeChromeTerminationOutcome(rollback)) {
      throw new AggregateError(
        [error, new Error(rollback.reason)],
        `Failed to persist Chrome owner authority, and safe launch rollback was unavailable.`,
      );
    }
    throw new Error(`Failed to persist Chrome owner authority for ${userDataDir}.`, {
      cause: error,
    });
  }
  return stableKill;
}

function retainChromeChildProcess(child: LaunchedChrome["process"]): StableChromeProcessHandle {
  return {
    get pid() {
      return child.pid;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill: (signal) => child.kill(signal),
    once: (event, listener) => child.once(event, listener),
    removeListener: (event, listener) => child.removeListener(event, listener),
    unref: () => child.unref(),
  };
}

export function createStableChildProcessChromeKill(
  child: StableChromeProcessHandle,
): ChromeStableKill {
  let pending: Promise<RecordedChromeTerminationOutcome> | undefined;
  return () => {
    pending ??= terminateStableChildProcess(child);
    return pending;
  };
}

async function terminateStableChildProcess(
  child: StableChromeProcessHandle,
): Promise<RecordedChromeTerminationOutcome> {
  const pid = child.pid;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { status: "already-stopped", pid };
  }
  if (!pid) {
    return {
      status: "unsafe",
      reason: "Retained Chrome process handle has no stable process id",
    };
  }
  const gracefulExit = waitForChildProcessExit(child, 5_000);
  try {
    if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null) {
      return { status: "unsafe", pid, reason: "Retained Chrome process handle rejected SIGTERM" };
    }
  } catch (error) {
    return {
      status: "unsafe",
      pid,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (await gracefulExit) return { status: "stopped", pid, signal: "SIGTERM" };
  if (child.exitCode !== null || child.signalCode !== null) {
    return { status: "stopped", pid, signal: "SIGTERM" };
  }

  const forcedExit = waitForChildProcessExit(child, 2_000);
  try {
    if (!child.kill("SIGKILL") && child.exitCode === null && child.signalCode === null) {
      return { status: "unsafe", pid, reason: "Retained Chrome process handle rejected SIGKILL" };
    }
  } catch (error) {
    return {
      status: "unsafe",
      pid,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return (await forcedExit)
    ? { status: "stopped", pid, signal: "SIGKILL" }
    : { status: "unsafe", pid, reason: "Chrome did not exit through its retained process handle" };
}

async function waitForChildProcessExit(
  child: StableChromeProcessHandle,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((resolvePromise) => {
    resolve = resolvePromise;
  });
  const onExit = () => {
    clearTimeout(timeout);
    resolve(true);
  };
  const timeout = setTimeout(() => {
    child.removeListener("exit", onExit);
    resolve(child.exitCode !== null || child.signalCode !== null);
  }, timeoutMs);
  timeout.unref();
  child.once("exit", onExit);
  return await promise;
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
  chrome: ChromeLaunchResult,
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
    /** Terminate Chrome and remove a throwaway copied profile even while in flight. */
    forceProfileCleanup?: boolean;
    /** Test/embedding hook invoked after signal cleanup settles and before process exit. */
    onSignalHandled?: () => void;
  },
): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGQUIT"];
  let handling: boolean | undefined;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (handling) return;
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
        await opts?.emitRuntimeHint?.().catch(() => undefined);
        if (inFlight) {
          logger('Session still in flight; reattach with "oracle session <slug>" to continue.');
        }
        return;
      }

      const termination = await chrome.kill().catch(
        (error: unknown): RecordedChromeTerminationOutcome => ({
          status: "unsafe",
          pid: chrome.pid,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      if (!isSafeChromeTerminationOutcome(termination)) {
        logger(
          `Chrome termination was not authoritative; preserving profile and cleanup authority: ${termination.reason}`,
        );
        return;
      }
      if (opts?.preserveUserDataDir) {
        const cleaned = await cleanupStaleProfileState(userDataDir, logger, {
          lockRemovalMode: "never",
          expectedProfileIdentity: chrome.processIdentity.profileDirectory,
        }).catch(() => false);
        if (!cleaned) logger(`Preserved profile state because physical cleanup was not confirmed.`);
        return;
      }
      const removed = await removeProfileDirectoryIfIdentityMatches(
        userDataDir,
        chrome.processIdentity.profileDirectory,
      ).catch(() => false);
      if (!removed) logger(`Preserved profile because its physical cleanup authority changed.`);
    })().finally(() => {
      opts?.onSignalHandled?.();
      const exitCode = signal === "SIGINT" ? 130 : 1;
      process.exitCode = exitCode;
      const isTestRun = process.env.VITEST === "1" || process.env.NODE_ENV === "test";
      if (!isTestRun) process.exit(exitCode);
    });
  };

  for (const signal of signals) process.on(signal, handleSignal);
  return () => {
    for (const signal of signals) process.removeListener(signal, handleSignal);
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

interface VerifiedDevToolsEndpoint {
  port: number;
  browserWSEndpoint: string;
}

async function launchHiddenMacChrome({
  chromeFlags,
  chromePath,
  userDataDir,
  requestedPort,
  ignoreDefaultFlags,
  captureProcessIdentity,
  expectedProfileDirectory,
}: {
  chromeFlags: string[];
  chromePath?: string | null;
  userDataDir: string;
  requestedPort?: number;
  ignoreDefaultFlags?: boolean;
  captureProcessIdentity: typeof captureChromeProcessIdentity;
  expectedProfileDirectory: ProfileDirectoryIdentity;
}): Promise<StableChromeLauncher> {
  const resolvedChromePath = chromePath ?? Launcher.getFirstInstallation();
  if (!resolvedChromePath) throw new Error("Chrome is not installed.");

  const debugPortArgument = requestedPort ?? 0;
  const activePortBaseline =
    requestedPort === undefined
      ? await captureDevToolsActivePortBaseline(userDataDir, expectedProfileDirectory)
      : null;
  const effectiveFlags = ignoreDefaultFlags
    ? chromeFlags
    : [...Launcher.defaultFlags(), ...chromeFlags];
  const chromeArgs = [
    `--remote-debugging-port=${debugPortArgument}`,
    `--user-data-dir=${userDataDir}`,
    ...effectiveFlags,
    "about:blank",
  ];
  await execFileAsync(
    "/usr/bin/open",
    buildHiddenMacChromeOpenArgs(resolvedChromePath, chromeArgs),
  );

  const endpoint =
    requestedPort !== undefined
      ? await discoverBrowserWebSocketEndpoint("127.0.0.1", requestedPort)
      : await waitForVerifiedDevToolsActivePort(
          userDataDir,
          expectedProfileDirectory,
          activePortBaseline ?? new Map<string, string | null>(),
        );
  await waitForDebugPort(endpoint.port);
  const listeningPid = await resolveListeningPortOwnerPid(endpoint.port);
  const discovered = listeningPid
    ? await findRunningChromeProcessForProfile(userDataDir, debugPortArgument, listeningPid)
    : null;
  if (!discovered) {
    throw new Error(
      `Hidden Chrome endpoint ${endpoint.port} could not be bound to its exact profile process.`,
    );
  }
  const processIdentity = await captureProcessIdentity(userDataDir, discovered.pid);
  if (!sameProfileDirectoryIdentity(processIdentity.profileDirectory, expectedProfileDirectory)) {
    throw new Error(`Physical profile authority changed while binding hidden Chrome.`);
  }
  const kill = await retainExactChromeControlChannel(
    endpoint.browserWSEndpoint,
    userDataDir,
    processIdentity,
  );
  return {
    pid: discovered.pid,
    port: endpoint.port,
    process: undefined,
    remoteDebuggingPipes: null,
    kill,
    host: "127.0.0.1",
    processIdentity,
  };
}

async function captureDevToolsActivePortBaseline(
  userDataDir: string,
  expectedProfileDirectory: ProfileDirectoryIdentity,
): Promise<Map<string, string | null>> {
  const baseline = new Map<string, string | null>();
  for (const candidate of getDevToolsActivePortPaths(expectedProfileDirectory.canonicalPath)) {
    try {
      const entry = await lstat(candidate);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`Unsafe DevToolsActivePort entry: ${candidate}`);
      }
      baseline.set(candidate, await readFile(candidate, "utf8"));
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
      baseline.set(candidate, null);
    }
    await assertProfileDirectoryIdentity(
      userDataDir,
      expectedProfileDirectory,
      "Hidden Chrome DevTools baseline",
    );
  }
  return baseline;
}

async function waitForVerifiedDevToolsActivePort(
  userDataDir: string,
  expectedProfileDirectory: ProfileDirectoryIdentity,
  baseline: ReadonlyMap<string, string | null>,
  timeoutMs = 30_000,
): Promise<VerifiedDevToolsEndpoint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of getDevToolsActivePortPaths(expectedProfileDirectory.canonicalPath)) {
      let before: Stats;
      let raw: string;
      try {
        before = await lstat(candidate);
        if (before.isSymbolicLink() || !before.isFile()) {
          throw new Error(`Unsafe DevToolsActivePort entry: ${candidate}`);
        }
        raw = await readFile(candidate, "utf8");
      } catch (error) {
        if (readErrorCode(error) === "ENOENT") continue;
        throw error;
      }
      await assertProfileDirectoryIdentity(
        userDataDir,
        expectedProfileDirectory,
        "Hidden Chrome DevTools discovery",
      );
      const after = await lstat(candidate);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        baseline.get(candidate) === raw
      ) {
        continue;
      }
      const [rawPort, rawBrowserPath] = raw.split(/\r?\n/u);
      if (!/^\d+$/u.test(rawPort?.trim() ?? "")) continue;
      const port = Number.parseInt(rawPort?.trim() ?? "", 10);
      const browserPath = rawBrowserPath?.trim() ?? "";
      if (port <= 0 || port > 65_535 || !/^\/devtools\/browser\/[^/\s]+$/u.test(browserPath)) {
        continue;
      }
      return {
        port,
        browserWSEndpoint: `ws://127.0.0.1:${port}${browserPath}`,
      };
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for verified hidden Chrome DevToolsActivePort metadata.`);
}

async function discoverBrowserWebSocketEndpoint(
  host: string,
  port: number,
): Promise<VerifiedDevToolsEndpoint> {
  await waitForDebugPort(port);
  const response = await fetch(`http://${host}:${port}/json/version`);
  if (!response.ok) {
    throw new Error(`Chrome control-channel discovery failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof payload.webSocketDebuggerUrl !== "string") {
    throw new Error("Chrome did not expose an exact browser control channel");
  }
  const endpoint = new URL(payload.webSocketDebuggerUrl);
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== host ||
    Number.parseInt(endpoint.port, 10) !== port ||
    !/^\/devtools\/browser\/[^/]+$/u.test(endpoint.pathname)
  ) {
    throw new Error("Chrome returned an invalid exact browser control channel");
  }
  return { port, browserWSEndpoint: endpoint.toString() };
}

async function resolveListeningPortOwnerPid(
  port: number,
  execute: (file: string, args: string[]) => Promise<{ stdout: string }> = async (file, args) => {
    const { stdout } = await execFileAsync(file, args, { encoding: "utf8" });
    return { stdout: String(stdout ?? "") };
  },
): Promise<number | null> {
  try {
    const { stdout } = await execute("/usr/sbin/lsof", [
      "-nP",
      "-a",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fp",
    ]);
    const pids = new Set(
      stdout
        .split(/\r?\n/u)
        .map((line) => line.match(/^p(\d+)$/u)?.[1])
        .filter((value): value is string => Boolean(value))
        .map((value) => Number.parseInt(value, 10)),
    );
    if (pids.size !== 1) return null;
    const [pid] = pids;
    return pid && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function verifyListeningPortOwnedByProcessForTest(
  pid: number,
  port: number,
  execute: (file: string, args: string[]) => Promise<{ stdout: string }>,
): Promise<boolean> {
  return (await resolveListeningPortOwnerPid(port, execute)) === pid;
}

interface IdentityBoundChromeControlKillDeps {
  inspectProcessIdentity?: typeof inspectChromeProcessIdentity;
  timeoutMs?: number;
  pollMs?: number;
}

async function retainExactChromeControlChannel(
  browserWSEndpoint: string,
  userDataDir: string,
  processIdentity: ChromeProcessIdentity,
): Promise<ChromeStableKill> {
  const client = (await CDP({ target: browserWSEndpoint, local: true })) as ChromeClient;
  try {
    await client.Browser.getVersion();
    const endpoint = new URL(browserWSEndpoint);
    const port = Number.parseInt(endpoint.port, 10);
    const [listeningPid, inspection] = await Promise.all([
      resolveListeningPortOwnerPid(port),
      inspectChromeProcessIdentity(userDataDir, processIdentity),
    ]);
    if (listeningPid !== processIdentity.pid || inspection !== "current") {
      throw new Error(`Hidden Chrome control channel is not bound to the exact process generation`);
    }
    return createIdentityBoundChromeControlKill(client, userDataDir, processIdentity, {});
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

function createIdentityBoundChromeControlKill(
  client: ChromeClient,
  userDataDir: string,
  processIdentity: ChromeProcessIdentity,
  deps: IdentityBoundChromeControlKillDeps,
): ChromeStableKill {
  let completed: RecordedChromeTerminationOutcome | undefined;
  let pending: Promise<RecordedChromeTerminationOutcome> | undefined;
  let closeRequested = false;
  return () => {
    if (completed) return Promise.resolve(completed);
    if (pending) return pending;
    const attempt = (async (): Promise<RecordedChromeTerminationOutcome> => {
      if (!closeRequested) {
        const inspect = deps.inspectProcessIdentity ?? inspectChromeProcessIdentity;
        let current: ChromeProcessIdentityInspection;
        try {
          current = await inspect(userDataDir, processIdentity);
        } catch {
          current = "unavailable";
        }
        if (current === "exited") {
          await client.close().catch(() => undefined);
          completed = { status: "already-stopped", pid: processIdentity.pid };
          return completed;
        }
        if (current !== "current") {
          return {
            status: "unsafe",
            pid: processIdentity.pid,
            reason: "Exact Chrome process generation could not be reverified before Browser.close",
          };
        }
        try {
          await client.Browser.close();
          closeRequested = true;
          await client.close().catch(() => undefined);
        } catch (error) {
          return {
            status: "unsafe",
            pid: processIdentity.pid,
            reason: `Exact Chrome control channel failed: ${error instanceof Error ? error.message : error}`,
          };
        }
      }
      const inspection = await waitForExactChromeProcessExit(userDataDir, processIdentity, deps);
      if (inspection === "exited") {
        completed = {
          status: "stopped",
          pid: processIdentity.pid,
          signal: "CONTROL_CHANNEL",
        };
        return completed;
      }
      return {
        status: "unsafe",
        pid: processIdentity.pid,
        reason:
          inspection === "current"
            ? "Exact Chrome process generation remained alive after Browser.close"
            : "Exact Chrome process generation exit could not be proven",
      };
    })();
    pending = attempt;
    void attempt.then(
      () => {
        if (pending === attempt) pending = undefined;
      },
      () => {
        if (pending === attempt) pending = undefined;
      },
    );
    return attempt;
  };
}

export function createIdentityBoundChromeControlKillForTest(
  client: ChromeClient,
  userDataDir: string,
  processIdentity: ChromeProcessIdentity,
  deps: IdentityBoundChromeControlKillDeps,
): ChromeStableKill {
  return createIdentityBoundChromeControlKill(client, userDataDir, processIdentity, deps);
}

async function waitForExactChromeProcessExit(
  userDataDir: string,
  processIdentity: ChromeProcessIdentity,
  deps: IdentityBoundChromeControlKillDeps,
): Promise<ChromeProcessIdentityInspection> {
  const inspect = deps.inspectProcessIdentity ?? inspectChromeProcessIdentity;
  const deadline = Date.now() + (deps.timeoutMs ?? 5_000);
  let latest: ChromeProcessIdentityInspection = "unavailable";
  do {
    try {
      latest = await inspect(userDataDir, processIdentity);
    } catch {
      latest = "unavailable";
    }
    if (latest === "exited" || Date.now() >= deadline) return latest;
    await delay(deps.pollMs ?? 100);
  } while (Date.now() <= deadline);
  return latest;
}

async function waitForDebugPort(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
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
    if (connected) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for hidden Chrome on port ${port}.`);
}

function readErrorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
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
    Object.defineProperty(launcher, "isDebuggerReady", {
      configurable: true,
      value: function isDebuggerReady(this: Pick<Launcher, "port">): Promise<void> {
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
          client.once("error", (error) => {
            cleanup();
            reject(error);
          });
          client.once("connect", () => {
            cleanup();
            resolve();
          });
        });
      },
    });
  }

  await launcher.launch();
  const { chromeProcess, pid, port, remoteDebuggingPipes } = launcher;
  if (!chromeProcess || typeof pid !== "number" || typeof port !== "number") {
    throw new Error("Chrome launcher did not retain a process and debug port.");
  }
  return {
    pid,
    port,
    process: chromeProcess,
    kill: () => launcher.kill(),
    host: host ?? undefined,
    remoteDebuggingPipes,
  };
}
