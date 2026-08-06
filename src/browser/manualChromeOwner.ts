import { formatElapsed } from "../oracle/format.js";
import type { LaunchedChrome } from "chrome-launcher";
import {
  launchChrome,
  retainChromeEndpointAuthority,
  type ChromeLaunchResult,
  type RetainedChromeEndpointAuthority,
} from "./chromeLifecycle.js";
import {
  acquireProfileRunLock,
  captureChromeProcessIdentity,
  cleanupStaleProfileState,
  findRunningChromeDebugTargetForProfile,
  isSafeChromeTerminationOutcome,
  isProcessAlive,
  readDevToolsPort,
  readOracleChromeOwner,
  removeOracleChromeOwnerIfMatches,
  sameChromeProcessIdentity,
  sameProfileDirectoryIdentity,
  verifyChromeProcessIdentity,
  verifyDevToolsReachable,
  verifyProfileDirectoryIdentity,
  writeOracleChromeOwner,
  type ChromeOwnerDisposition,
  type ChromeOwnerPreservationPolicy,
  type ChromeProcessIdentity,
  type ChromeProcessLaunchClaim,
  type OracleChromeOwnerRecord,
  type ProfileDirectoryIdentity,
} from "./profileState.js";
import type { BrowserLogger, ResolvedBrowserConfig } from "./types.js";
import { delay } from "./utils.js";
import { releaseManualChromeOwnerEndpointAuthority } from "./manualChromeOwnerSettlement.js";

export type ManualChromeOwnerSource = "recorded" | "rediscovered" | "launched";

export type BrowserChrome = LaunchedChrome & { host?: string };

export interface ManualChromeOwner {
  readonly chrome: ChromeLaunchResult;
  readonly compatibilityChrome?: BrowserChrome;
  readonly processIdentity: ChromeProcessIdentity;
  readonly source: ManualChromeOwnerSource;
  readonly disposition: ChromeOwnerDisposition;
  readonly endpointAuthority?: RetainedChromeEndpointAuthority;
}

export interface ManualChromeOwnerDeps {
  acquireProfileLock?: typeof acquireProfileRunLock;
  captureProcessIdentity?: typeof captureChromeProcessIdentity;
  cleanupProfileState?: typeof cleanupStaleProfileState;
  compatibilityMaybeReuse?: ManualLoginChromeReuse;
  discoverExactProfileChrome?: typeof findRunningChromeDebugTargetForProfile;
  isOwnerProcessAlive?: typeof isProcessAlive;
  launchClaim?: ChromeProcessLaunchClaim;
  launch?: typeof launchChrome;
  retainEndpointAuthority?: typeof retainChromeEndpointAuthority;
  probe?: typeof verifyDevToolsReachable;
  readOwner?: typeof readOracleChromeOwner;
  removeOwnerIfMatches?: typeof removeOracleChromeOwnerIfMatches;
  readPort?: typeof readDevToolsPort;
  verifyIdentity?: typeof verifyChromeProcessIdentity;
  writeOwner?: typeof writeOracleChromeOwner;
  /** Service bootstrap establishes a durable preserve policy direct runs cannot replace. */
  ownerPolicy?: ChromeOwnerPreservationPolicy;
}

interface ManualLoginReusableChrome extends BrowserChrome {
  processIdentity?: ChromeProcessIdentity;
  endpointAuthority?: RetainedChromeEndpointAuthority;
}

type ManualLoginChromeReuse = (
  userDataDir: string,
  logger: BrowserLogger,
  options: { waitForPortMs?: number },
) => Promise<ManualLoginReusableChrome | null>;
type ManualLoginChromeLaunch = (
  config: ResolvedBrowserConfig,
  userDataDir: string,
  logger: BrowserLogger,
) => Promise<BrowserChrome>;

interface AcquireManualLoginChromeForRunDeps extends Omit<
  ManualChromeOwnerDeps,
  "compatibilityMaybeReuse" | "launch"
> {
  maybeReuse?: ManualLoginChromeReuse;
  launch?: ManualLoginChromeLaunch;
}

export {
  releaseManualChromeOwnerEndpointAuthority,
  settleManualChromeOwner,
  type ManualChromeOwnerSettlement,
} from "./manualChromeOwnerSettlement.js";

/**
 * Acquire the one canonical Chrome process for a persistent manual-login profile.
 * The atomic Oracle owner record is authoritative; DevToolsActivePort is only a discovery hint.
 * Tab leases authorize tabs, never another browser process.
 */
export async function acquireManualChromeOwner(
  profileDir: string,
  config: ResolvedBrowserConfig,
  logger: BrowserLogger,
  sessionId?: string,
  deps: ManualChromeOwnerDeps = {},
): Promise<ManualChromeOwner> {
  const acquireLock = deps.acquireProfileLock ?? acquireProfileRunLock;
  const lockTimeoutMs = Math.max(1, config.profileLockTimeoutMs ?? 1);
  const launchLock = await acquireLock(profileDir, {
    timeoutMs: lockTimeoutMs,
    pollMs: 50,
    logger,
    sessionId,
  });
  if (!launchLock) {
    throw new Error(`Unable to acquire canonical Chrome owner lock for ${profileDir}`);
  }

  let acquiredOwner: ManualChromeOwner | null = null;
  let acquisitionFailed = false;
  let acquisitionError: unknown;
  try {
    const existing = deps.compatibilityMaybeReuse
      ? await acquireCompatibilityManualChromeOwner(
          profileDir,
          config,
          logger,
          launchLock.profileDirectory,
          deps,
        )
      : await findExistingManualChromeOwner(
          profileDir,
          config,
          logger,
          launchLock.profileDirectory,
          deps,
        );
    if (existing) {
      acquiredOwner = existing;
    } else {
      if (!(await verifyProfileDirectoryIdentity(profileDir, launchLock.profileDirectory))) {
        throw new Error(
          `Physical profile authority changed before launching canonical Chrome owner for ${profileDir}`,
        );
      }
      const launch = deps.launch ?? launchChrome;
      const chrome = await launch(
        {
          ...config,
          remoteChrome: config.remoteChrome,
        },
        profileDir,
        logger,
        { launchClaim: deps.launchClaim },
      );
      if (
        !sameProfileDirectoryIdentity(
          chrome.processIdentity.profileDirectory,
          launchLock.profileDirectory,
        )
      ) {
        const mismatch = new Error(
          `Physical profile authority changed while launching canonical Chrome owner for ${profileDir}`,
        );
        const termination = await chrome.kill().catch((error: unknown) => ({
          status: "unsafe" as const,
          pid: chrome.pid,
          reason: error instanceof Error ? error.message : String(error),
        }));
        if (!isSafeChromeTerminationOutcome(termination)) {
          throw new AggregateError(
            [mismatch, new Error(termination.reason)],
            `Physical profile authority changed during launch, and safe rollback was unavailable.`,
          );
        }
        throw mismatch;
      }
      let pid: number;
      let port: number;
      let processIdentity: ChromeProcessIdentity;
      let ownerRecord: OracleChromeOwnerRecord | null = null;
      try {
        pid = requirePositiveInteger(chrome.pid, "pid", profileDir);
        port = requirePositiveInteger(chrome.port, "DevTools port", profileDir);
        processIdentity = requireProcessIdentity(chrome.processIdentity, pid, profileDir);
        ownerRecord = ownerRecordForCurrentRun(profileDir, port, processIdentity, config, deps);
        await persistCanonicalOwner(profileDir, ownerRecord, deps);
      } catch (error) {
        const failures = [error instanceof Error ? error : new Error(String(error))];
        const termination = await chrome.kill().catch((terminationError: unknown) => ({
          status: "unsafe" as const,
          pid: chrome.pid,
          reason:
            terminationError instanceof Error ? terminationError.message : String(terminationError),
        }));
        if (!isSafeChromeTerminationOutcome(termination)) {
          failures.push(new Error(termination.reason));
        } else if (ownerRecord) {
          try {
            const removed = await (deps.removeOwnerIfMatches ?? removeOracleChromeOwnerIfMatches)(
              profileDir,
              ownerRecord,
            );
            if (!removed) {
              failures.push(new Error("Chrome launch rollback owner removal was not confirmed"));
            }
          } catch (removalError) {
            failures.push(
              removalError instanceof Error ? removalError : new Error(String(removalError)),
            );
          }
        }
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            "Canonical Chrome owner acquisition rollback did not settle safely",
          );
        }
        throw error;
      }

      if (!ownerRecord) {
        throw new Error(`Canonical Chrome owner policy was not resolved for ${profileDir}`);
      }

      logger(
        `Launched canonical Chrome owner for ${profileDir} (DevTools port ${port}, pid ${pid})`,
      );
      acquiredOwner = {
        chrome,
        processIdentity,
        source: "launched",
        disposition: ownerRecord.disposition,
        endpointAuthority: chrome.endpointAuthority,
      };
    }
  } catch (error) {
    acquisitionFailed = true;
    acquisitionError = error;
  }

  try {
    await launchLock.release();
  } catch (releaseError) {
    const failures: unknown[] = [];
    if (acquisitionFailed) failures.push(acquisitionError);
    failures.push(releaseError);
    if (acquiredOwner?.disposition === "close-on-last-lease") {
      const termination = await acquiredOwner.chrome.kill().catch((terminationError: unknown) => ({
        status: "unsafe" as const,
        pid: acquiredOwner?.chrome.pid,
        reason:
          terminationError instanceof Error ? terminationError.message : String(terminationError),
      }));
      if (!isSafeChromeTerminationOutcome(termination)) {
        failures.push(new Error(termination.reason));
      }
    } else if (acquiredOwner?.endpointAuthority) {
      try {
        await acquiredOwner.endpointAuthority.release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `Canonical Chrome owner acquisition or lock release did not settle safely.`,
        { cause: failures[0] },
      );
    }
    throw releaseError;
  }

  if (acquisitionFailed) throw acquisitionError;
  if (!acquiredOwner) {
    throw new Error(
      `Canonical Chrome owner acquisition completed without an owner for ${profileDir}`,
    );
  }
  return acquiredOwner;
}

export async function acquireManualLoginChromeForRun(
  userDataDir: string,
  config: ResolvedBrowserConfig,
  logger: BrowserLogger,
  sessionId?: string,
  deps: AcquireManualLoginChromeForRunDeps = {},
): Promise<{ chrome: BrowserChrome; reusedChrome: LaunchedChrome | null }> {
  const { maybeReuse, launch, ...ownerDeps } = deps;
  let compatibilityLaunchedChrome: BrowserChrome | null = null;
  const compatibilityLaunch: ManualChromeOwnerDeps["launch"] | undefined = launch
    ? async (launchConfig, launchUserDataDir, launchLogger) => {
        const launched = await launch(launchConfig, launchUserDataDir, launchLogger);
        compatibilityLaunchedChrome = launched;
        return (await retainCompatibilityChromeAuthority(launched, launchUserDataDir, ownerDeps))
          .chrome;
      }
    : undefined;
  const owner = await acquireManualChromeOwner(userDataDir, config, logger, sessionId, {
    ...ownerDeps,
    compatibilityMaybeReuse: maybeReuse,
    launch: compatibilityLaunch,
  });
  const chrome =
    owner.compatibilityChrome ??
    compatibilityLaunchedChrome ??
    (owner.source === "launched"
      ? launchedCompatibilityChrome(owner.chrome)
      : borrowedCompatibilityChrome(owner.chrome));
  const reusedChrome = owner.source === "launched" ? null : chrome;
  if (reusedChrome || compatibilityLaunchedChrome) {
    await releaseManualChromeOwnerEndpointAuthority(owner);
  }
  return { chrome, reusedChrome };
}
async function acquireCompatibilityManualChromeOwner(
  profileDir: string,
  config: ResolvedBrowserConfig,
  logger: BrowserLogger,
  expectedProfileDirectory: ProfileDirectoryIdentity,
  deps: ManualChromeOwnerDeps,
): Promise<ManualChromeOwner | null> {
  const reusable = await deps.compatibilityMaybeReuse?.(profileDir, logger, {
    waitForPortMs: config.reuseChromeWaitMs,
  });
  if (!reusable) return null;

  const authority = await retainCompatibilityChromeAuthority(
    reusable,
    profileDir,
    deps,
    expectedProfileDirectory,
  );
  const { pid, port, processIdentity, endpointAuthority, chrome } = authority;
  const ownerRecord = ownerRecordForCurrentRun(
    profileDir,
    port,
    processIdentity,
    config,
    deps,
    await (deps.readOwner ?? readOracleChromeOwner)(profileDir),
  );
  await persistCanonicalOwner(profileDir, ownerRecord, deps);
  logger(`Reusing canonical Chrome owner for ${profileDir} (DevTools port ${port}, pid ${pid})`);
  return {
    compatibilityChrome: reusable,
    chrome,
    processIdentity,
    source: "rediscovered",
    disposition: ownerRecord.disposition,
    endpointAuthority,
  };
}

function launchedCompatibilityChrome(chrome: ChromeLaunchResult): BrowserChrome {
  return {
    pid: chrome.pid,
    port: chrome.port,
    host: chrome.host,
    process: chrome.process as LaunchedChrome["process"],
    remoteDebuggingPipes: chrome.remoteDebuggingPipes,
    kill: async () => {
      const termination = await chrome.kill();
      if (!isSafeChromeTerminationOutcome(termination)) {
        throw new Error(
          `Canonical Chrome owner could not be terminated safely: ${termination.reason}`,
        );
      }
    },
  };
}

function borrowedCompatibilityChrome(chrome: ChromeLaunchResult): BrowserChrome {
  return {
    pid: chrome.pid,
    port: chrome.port,
    host: chrome.host,
    process: undefined as unknown as LaunchedChrome["process"],
    remoteDebuggingPipes: chrome.remoteDebuggingPipes,
    kill: async () => undefined,
  };
}
async function retainCompatibilityChromeAuthority(
  chrome: ManualLoginReusableChrome,
  profileDir: string,
  deps: ManualChromeOwnerDeps,
  expectedProfileDirectory?: ProfileDirectoryIdentity,
): Promise<{
  pid: number;
  port: number;
  processIdentity: ChromeProcessIdentity;
  endpointAuthority: RetainedChromeEndpointAuthority;
  chrome: ChromeLaunchResult;
}> {
  const pid = requirePositiveInteger(chrome.pid, "Chrome pid", profileDir);
  const port = requirePositiveInteger(chrome.port, "Chrome DevTools port", profileDir);
  const processIdentity = chrome.processIdentity
    ? requireProcessIdentity(chrome.processIdentity, pid, profileDir)
    : await (deps.captureProcessIdentity ?? captureChromeProcessIdentity)(profileDir, pid);
  if (
    expectedProfileDirectory &&
    !sameProfileDirectoryIdentity(processIdentity.profileDirectory, expectedProfileDirectory)
  ) {
    throw new Error(
      `Reused Chrome process identity does not match the canonical profile authority for ${profileDir}`,
    );
  }
  const endpointAuthority =
    chrome.endpointAuthority ??
    (await (deps.retainEndpointAuthority ?? retainChromeEndpointAuthority)({
      host: chrome.host ?? "127.0.0.1",
      port,
      userDataDir: profileDir,
      processIdentity,
    }));
  return {
    pid,
    port,
    processIdentity,
    endpointAuthority,
    chrome: {
      pid,
      port,
      host: chrome.host,
      process: undefined,
      remoteDebuggingPipes: chrome.remoteDebuggingPipes,
      processIdentity,
      endpointAuthority,
      kill: endpointAuthority.kill,
    } as unknown as ChromeLaunchResult,
  };
}
async function findExistingManualChromeOwner(
  profileDir: string,
  config: ResolvedBrowserConfig,
  logger: BrowserLogger,
  expectedProfileDirectory: ProfileDirectoryIdentity,
  deps: ManualChromeOwnerDeps,
): Promise<ManualChromeOwner | null> {
  if (!(await verifyProfileDirectoryIdentity(profileDir, expectedProfileDirectory))) {
    throw new Error(
      `Physical profile authority changed while acquiring Chrome owner for ${profileDir}`,
    );
  }
  const readPort = deps.readPort ?? readDevToolsPort;
  const readOwner = deps.readOwner ?? readOracleChromeOwner;
  const verifyIdentity = deps.verifyIdentity ?? verifyChromeProcessIdentity;
  const discoverExact = deps.discoverExactProfileChrome ?? findRunningChromeDebugTargetForProfile;
  const retainEndpointAuthority = deps.retainEndpointAuthority ?? retainChromeEndpointAuthority;
  const probe = deps.probe ?? verifyDevToolsReachable;
  const ownerProcessAlive = deps.isOwnerProcessAlive ?? isProcessAlive;

  const recordedOwner = await readOwner(profileDir);
  const recordedIdentity = recordedOwner?.processIdentity;
  const recordedIdentityVerified = Boolean(
    recordedIdentity &&
    sameProfileDirectoryIdentity(recordedIdentity.profileDirectory, expectedProfileDirectory) &&
    (await verifyIdentity(profileDir, recordedIdentity)),
  );
  if (recordedOwner && recordedIdentity && recordedIdentityVerified) {
    const recordedPort = requirePositiveInteger(
      recordedOwner.port,
      "recorded DevTools port",
      profileDir,
    );
    const recordedPid = requirePositiveInteger(recordedIdentity.pid, "recorded pid", profileDir);
    let endpointAuthority: RetainedChromeEndpointAuthority;
    try {
      endpointAuthority = await retainEndpointAuthority({
        host: "127.0.0.1",
        port: recordedPort,
        userDataDir: profileDir,
        processIdentity: recordedIdentity,
      });
    } catch (error) {
      throw new Error(
        `Verified Chrome owner for ${profileDir} is running as pid ${recordedPid}, but DevTools port ${recordedPort} is not bound to that exact process generation; refusing to launch a second browser process`,
        { cause: error },
      );
    }
    const ownerRecord = ownerRecordForCurrentRun(
      profileDir,
      recordedPort,
      recordedIdentity,
      config,
      deps,
      recordedOwner,
    );
    await persistCanonicalOwner(profileDir, ownerRecord, deps);
    logger(
      `Reusing canonical Chrome owner for ${profileDir} (DevTools port ${recordedPort}, pid ${recordedPid})`,
    );
    return {
      chrome: reusableChrome(recordedPort, recordedPid, recordedIdentity, endpointAuthority),
      processIdentity: recordedIdentity,
      source: "recorded",
      disposition: ownerRecord.disposition,
      endpointAuthority,
    };
  }
  let activePort = await readPort(profileDir);
  const waitMs = Math.max(0, config.reuseChromeWaitMs ?? 0);
  if (!activePort && waitMs > 0) {
    const deadline = Date.now() + waitMs;
    logger(`Waiting up to ${formatElapsed(waitMs)} for canonical Chrome owner to appear...`);
    while (!activePort && Date.now() < deadline) {
      await delay(250);
      activePort = await readPort(profileDir);
    }
  }

  const discovered = await discoverExact(profileDir);
  if (discovered) {
    throw new Error(
      `Chrome is already running for ${profileDir} as pid ${discovered.pid}, but no exact Oracle owner authority authenticates that process; refusing to adopt a pre-existing manual-login browser`,
    );
  }

  if (activePort) {
    const reachable = await probe({ port: activePort });
    if (reachable.ok) {
      throw new Error(
        `DevTools port ${activePort} is reachable for ${profileDir}, but its exact Chrome process/profile owner could not be verified; refusing to launch a second browser process`,
      );
    }
  }
  const possiblyLivePid = recordedIdentity?.pid;
  if (possiblyLivePid && ownerProcessAlive(possiblyLivePid)) {
    throw new Error(
      `Recorded Chrome owner pid ${possiblyLivePid} is still alive for ${profileDir}, but no exact reachable profile owner was verified; refusing to launch a second browser process`,
    );
  }

  if (activePort || recordedOwner) {
    const cleaned = await (deps.cleanupProfileState ?? cleanupStaleProfileState)(
      profileDir,
      logger,
      {
        lockRemovalMode: "if_oracle_pid_dead",
        expectedProfileIdentity: expectedProfileDirectory,
      },
    );
    if (!cleaned) {
      throw new Error(
        `Stale Chrome owner state for ${profileDir} could not be cleared safely; refusing to launch a second browser process`,
      );
    }
  }
  return null;
}

function ownerRecordForCurrentRun(
  profileDir: string,
  port: number,
  processIdentity: ChromeProcessIdentity,
  config: ResolvedBrowserConfig,
  deps: ManualChromeOwnerDeps,
  current?: OracleChromeOwnerRecord | null,
): OracleChromeOwnerRecord {
  if (current?.preservationPolicy === "service-persistent") {
    if (
      current.port !== port ||
      !sameChromeProcessIdentity(current.processIdentity, processIdentity)
    ) {
      throw new Error(
        `Service-owned Chrome authority for ${profileDir} does not match the exact reused process`,
      );
    }
    return current;
  }
  const preservationPolicy = deps.ownerPolicy;
  return {
    port,
    processIdentity,
    disposition: preservationPolicy
      ? "preserve"
      : config.keepBrowser
        ? "preserve"
        : "close-on-last-lease",
    ...(preservationPolicy ? { preservationPolicy } : {}),
  };
}

async function persistCanonicalOwner(
  profileDir: string,
  owner: OracleChromeOwnerRecord,
  deps: ManualChromeOwnerDeps,
): Promise<void> {
  const writeOwner = deps.writeOwner ?? writeOracleChromeOwner;
  const readOwner = deps.readOwner ?? readOracleChromeOwner;
  const verifyIdentity = deps.verifyIdentity ?? verifyChromeProcessIdentity;
  const pid = owner.processIdentity.pid;

  requirePositiveInteger(owner.port, "DevTools port", profileDir);
  requireProcessIdentity(owner.processIdentity, pid, profileDir);
  const persistedOwner = await readOwner(profileDir);
  if (
    !persistedOwner ||
    persistedOwner.port !== owner.port ||
    persistedOwner.disposition !== owner.disposition ||
    persistedOwner.preservationPolicy !== owner.preservationPolicy ||
    !sameChromeProcessIdentity(persistedOwner.processIdentity, owner.processIdentity)
  ) {
    await writeOwner(profileDir, owner);
  }
  const verifiedOwner = await readOwner(profileDir);
  const identityVerified = await verifyIdentity(profileDir, owner.processIdentity);
  if (
    !verifiedOwner ||
    verifiedOwner.port !== owner.port ||
    verifiedOwner.disposition !== owner.disposition ||
    verifiedOwner.preservationPolicy !== owner.preservationPolicy ||
    !sameChromeProcessIdentity(verifiedOwner.processIdentity, owner.processIdentity) ||
    !identityVerified
  ) {
    throw new Error(
      `Failed to persist canonical Chrome owner authority for ${profileDir} (expected pid ${pid}, port ${owner.port}; found pid ${verifiedOwner?.processIdentity.pid ?? "missing"}, port ${verifiedOwner?.port ?? "missing"}, identity ${identityVerified ? "verified" : "unverified"})`,
    );
  }
}

function reusableChrome(
  port: number,
  pid: number,
  processIdentity: ChromeProcessIdentity,
  endpointAuthority: RetainedChromeEndpointAuthority,
): ChromeLaunchResult {
  return {
    port,
    pid,
    processIdentity,
    endpointAuthority,
    kill: endpointAuthority.kill,
    process: undefined,
  } as unknown as ChromeLaunchResult;
}

function requireProcessIdentity(
  identity: ChromeProcessIdentity | undefined,
  pid: number,
  profileDir: string,
): ChromeProcessIdentity {
  if (
    !identity ||
    identity.pid !== pid ||
    !identity.processStartTime ||
    !identity.executablePath ||
    !identity.normalizedUserDataDir ||
    !identity.launchNonce ||
    !identity.profileDirectory
  ) {
    throw new Error(
      `Canonical Chrome owner for ${profileDir} has no valid immutable process identity for pid ${pid}`,
    );
  }
  return identity;
}

function requirePositiveInteger(
  value: number | undefined,
  label: string,
  profileDir: string,
): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    throw new Error(`Canonical Chrome owner for ${profileDir} has no valid ${label}`);
  }
  return Math.trunc(value as number);
}
