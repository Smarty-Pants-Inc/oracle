import net from "node:net";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { promisify } from "node:util";
import { launch, Launcher, type LaunchedChrome } from "chrome-launcher";
import { readErrorCode } from "../fsDurability.js";
import type { BrowserLogger, ResolvedBrowserConfig } from "./types.js";
import type { BrowserLevelChromeClient } from "./chromeSessionTransport.js";
import {
  captureChromeProcessIdentity,
  inspectChromeProcessIdentity,
  type ChromeProcessIdentity,
} from "./chromeProcessIdentity.js";
import { findRunningChromeProcessForProfile } from "./chromeProcessDiscovery.js";
import {
  buildChromeProcessLaunchClaimFlag,
  createChromeProcessLaunchClaim,
  sameChromeProcessLaunchClaim,
  type ChromeProcessLaunchClaim,
} from "./chromeProcessLaunchClaim.js";
import {
  assertProfileDirectoryIdentity,
  captureProfileDirectoryIdentity,
  cleanupStaleProfileState,
  getDevToolsActivePortPaths,
  isSafeChromeTerminationOutcome,
  removeProfileDirectoryIfIdentityMatches,
  sameProfileDirectoryIdentity,
  writeOracleChromeOwner,
  type ProfileDirectoryIdentity,
  type ProfileDirectoryUseDeps,
  type RecordedChromeTerminationOutcome,
} from "./profileState.js";
import { delay } from "./utils.js";
import {
  createEndpointBoundChildProcessChromeKill,
  createLaunchedChromeEndpointControl,
  createOwnerBoundChromeKill,
  createStableChildProcessChromeKill,
  discoverBrowserWebSocketEndpoint,
  resolveListeningPortOwnerPid,
  retainChromeChildProcess,
  retainExactChromeEndpointAuthority,
  waitForDebugPort,
  type ChromeStableKill,
  type RetainedChromeEndpointAuthority,
  type StableChromeProcessHandle,
} from "./chromeEndpointAuthority.js";
import { isWsl, resolveWslChromeLaunchRoute } from "./wslHost.js";
const execFileAsync = promisify(execFile);

export * from "./chromeEndpointAuthority.js";

export interface ChromeLaunchResult {
  readonly pid: number;
  readonly port: number;
  readonly process?: StableChromeProcessHandle;
  readonly remoteDebuggingPipes: LaunchedChrome["remoteDebuggingPipes"];
  readonly host?: string;
  readonly kill: ChromeStableKill;
  readonly processIdentity: ChromeProcessIdentity;
  readonly endpointAuthority?: RetainedChromeEndpointAuthority;
}

interface StableChromeLauncher {
  readonly pid?: number;
  readonly port: number;
  readonly process?: StableChromeProcessHandle;
  readonly remoteDebuggingPipes: LaunchedChrome["remoteDebuggingPipes"];
  readonly kill: ChromeStableKill;
  readonly host?: string;
  readonly processIdentity?: ChromeProcessIdentity;
  readonly endpointAuthority?: RetainedChromeEndpointAuthority;
}

export interface ChromeLaunchDeps {
  platform?: NodeJS.Platform;
  launchClaim?: ChromeProcessLaunchClaim;
  standardLaunch?: typeof launch;
  customHostLaunch?: typeof launchWithCustomHost;
  hiddenMacLaunch?: typeof launchHiddenMacChrome;
  resolveLaunchRoute?: typeof resolveWslChromeLaunchRoute;
  captureProcessIdentity?: typeof captureChromeProcessIdentity;
  inspectProcessIdentity?: typeof inspectChromeProcessIdentity;
  captureProfileIdentity?: typeof captureProfileDirectoryIdentity;
  writeOwner?: typeof writeOracleChromeOwner;
  retainEndpointAuthority?: (options: {
    host: string;
    port: number;
    userDataDir: string;
    processIdentity: ChromeProcessIdentity;
  }) => Promise<RetainedChromeEndpointAuthority>;
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
  const launchClaim = deps.launchClaim ?? createChromeProcessLaunchClaim();
  const debugPort = config.debugPort ?? parseDebugPortEnv();
  const chromeFlags = buildChromeFlags(
    config.headless ?? false,
    debugBindAddress,
    config.hideWindow ?? false,
  );
  chromeFlags.push(buildChromeProcessLaunchClaimFlag(launchClaim));
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
      launchClaim,
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
        `Launched Chrome for ${launchUserDataDir} did not expose retained process-exit observation; refusing ambiguous lifecycle authority.`,
      );
    }
    const retainedProcess = retainChromeChildProcess(launched.process);
    launcher = {
      pid: launched.pid,
      port: launched.port,
      process: retainedProcess,
      remoteDebuggingPipes: launched.remoteDebuggingPipes,
      host: launched.host,
      kill: createStableChildProcessChromeKill(retainedProcess, async () => ({
        status: "unsafe",
        pid: retainedProcess.pid,
        reason: "Exact Chrome control authority is unavailable before process identity capture",
      })),
    };
  }

  const processIdentity =
    launcher.processIdentity ??
    (await captureLaunchedChromeProcessIdentity(
      launchUserDataDir,
      launcher,
      profileDirectory,
      deps.captureProcessIdentity ?? captureChromeProcessIdentity,
      launchClaim,
    ));
  if (!sameChromeProcessLaunchClaim(processIdentity.launchClaim, launchClaim)) {
    const claimError = new Error(
      `Launched Chrome for ${launchUserDataDir} did not expose the durable launch claim.`,
    );
    const rollback = await launcher.kill();
    if (!isSafeChromeTerminationOutcome(rollback)) {
      throw new AggregateError(
        [claimError, new Error(rollback.reason)],
        `Chrome launch claim was not observable, and safe launch rollback was unavailable.`,
      );
    }
    throw claimError;
  }
  const launchHost = launcher.host ?? connectHost ?? "127.0.0.1";
  let stableKill: ChromeStableKill;
  let endpointAuthority = launcher.endpointAuthority;
  if (hiddenHeadfulLaunch) {
    stableKill = launcher.kill;
  } else {
    if (!launcher.process) {
      throw new Error(`Launched Chrome for ${launchUserDataDir} lost process-exit observation.`);
    }
    const control = await createLaunchedChromeEndpointControl(
      {
        host: launchHost,
        port: launcher.port,
        userDataDir: launchUserDataDir,
        processIdentity,
      },
      {
        retainEndpointAuthority: deps.retainEndpointAuthority,
        inspectProcessIdentity: deps.inspectProcessIdentity,
      },
    );
    const initialEndpointAuthority = control.readEndpointAuthority();
    if (!initialEndpointAuthority) {
      const authorityError = new Error(
        `Launched Chrome for ${launchUserDataDir} did not retain exact endpoint release authority.`,
      );
      const rollback = await createStableChildProcessChromeKill(launcher.process, control.kill)();
      if (!isSafeChromeTerminationOutcome(rollback)) {
        throw new AggregateError(
          [authorityError, new Error(rollback.reason)],
          `Chrome endpoint release authority was unavailable, and safe launch rollback was unavailable.`,
        );
      }
      const rollbackEndpointAuthority = control.readEndpointAuthority();
      if (rollbackEndpointAuthority) {
        try {
          await rollbackEndpointAuthority.release();
        } catch (releaseError) {
          throw new AggregateError(
            [
              authorityError,
              releaseError instanceof Error ? releaseError : new Error(String(releaseError)),
            ],
            `Chrome endpoint release authority was retained during rollback but could not be released.`,
          );
        }
      }
      throw authorityError;
    }
    const finalEndpointAuthority = control.readEndpointAuthority();
    if (finalEndpointAuthority) {
      stableKill = createEndpointBoundChildProcessChromeKill(
        launcher.process,
        control.kill,
        finalEndpointAuthority,
      );
      endpointAuthority = Object.freeze({
        ...finalEndpointAuthority,
        kill: stableKill,
      });
    } else {
      stableKill = createStableChildProcessChromeKill(launcher.process, control.kill);
    }
  }
  if (!sameProfileDirectoryIdentity(processIdentity.profileDirectory, profileDirectory)) {
    const mismatch = new Error(
      `Physical Chrome profile authority changed during launch: ${launchUserDataDir}`,
    );
    const rollback = await stableKill();
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
    {
      port: launcher.port,
      processIdentity,
      disposition: config.keepBrowser ? "preserve" : "close-on-last-lease",
    },
    stableKill,
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
    host: launchHost,
    processIdentity,
    kill,
    endpointAuthority,
  };
}

async function captureLaunchedChromeProcessIdentity(
  userDataDir: string,
  launcher: StableChromeLauncher,
  expectedProfileDirectory: ProfileDirectoryIdentity,
  capture: typeof captureChromeProcessIdentity,
  launchClaim: ChromeProcessLaunchClaim,
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
    const identity = await capture(userDataDir, pid, launchClaim);
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

export async function positionChromeWindowOffscreen(
  client: BrowserLevelChromeClient,
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
    /** Return true until the captured answer has completed its publication safety checks. */
    isInFlight?: () => boolean;
    /** Persist runtime hints so reattach can find the live Chrome. */
    emitRuntimeHint?: () => Promise<void>;
    /** Preserve the profile directory even when Chrome is terminated. */
    preserveUserDataDir?: boolean;
    /** Terminate Chrome and remove a throwaway copied profile even while in flight. */
    forceProfileCleanup?: boolean;
    /** Test/embedding seam for deterministic complete process-use inspection. */
    profileDirectoryUseDeps?: ProfileDirectoryUseDeps;
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
        `Received ${signal}; leaving Chrome running${inFlight ? " (answer publication pending)" : ""}`,
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
        const cleaned = await cleanupStaleProfileState(
          userDataDir,
          logger,
          {
            lockRemovalMode: "never",
            expectedProfileIdentity: chrome.processIdentity.profileDirectory,
          },
          opts.profileDirectoryUseDeps,
        ).catch(() => false);
        if (!cleaned) logger(`Preserved profile state because physical cleanup was not confirmed.`);
        return;
      }
      const removed = await removeProfileDirectoryIfIdentityMatches(
        userDataDir,
        chrome.processIdentity.profileDirectory,
        opts?.profileDirectoryUseDeps,
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

export * from "./chromeTargetConnection.js";

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
  launchClaim,
}: {
  chromeFlags: string[];
  chromePath?: string | null;
  userDataDir: string;
  requestedPort?: number;
  ignoreDefaultFlags?: boolean;
  captureProcessIdentity: typeof captureChromeProcessIdentity;
  expectedProfileDirectory: ProfileDirectoryIdentity;
  launchClaim: ChromeProcessLaunchClaim;
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
    ? await findRunningChromeProcessForProfile(
        userDataDir,
        debugPortArgument,
        listeningPid,
        launchClaim,
      )
    : null;
  if (!discovered) {
    throw new Error(
      `Hidden Chrome endpoint ${endpoint.port} could not be bound to its exact profile process.`,
    );
  }
  const processIdentity = await captureProcessIdentity(userDataDir, discovered.pid, launchClaim);
  if (!sameProfileDirectoryIdentity(processIdentity.profileDirectory, expectedProfileDirectory)) {
    throw new Error(`Physical profile authority changed while binding hidden Chrome.`);
  }
  const endpointAuthority = await retainExactChromeEndpointAuthority(
    endpoint.browserWSEndpoint,
    userDataDir,
    processIdentity,
  );
  return {
    pid: discovered.pid,
    port: endpoint.port,
    process: undefined,
    remoteDebuggingPipes: null,
    kill: endpointAuthority.kill,
    endpointAuthority,
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
}): Promise<Omit<LaunchedChrome, "kill"> & { host?: string }> {
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
    host: host ?? undefined,
    remoteDebuggingPipes,
  };
}
