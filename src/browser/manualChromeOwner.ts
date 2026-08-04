import { formatElapsed } from "../oracle/format.js";
import { launchChrome, type ChromeLaunchResult } from "./chromeLifecycle.js";
import {
  acquireProfileRunLock,
  captureChromeProcessIdentity,
  cleanupStaleProfileState,
  findRunningChromeDebugTargetForProfile,
  isProcessAlive,
  readChromePid,
  readChromeProcessIdentity,
  readDevToolsPort,
  sameChromeProcessIdentity,
  verifyChromeProcessIdentity,
  verifyDevToolsReachable,
  writeChromePid,
  writeChromeProcessIdentity,
  writeDevToolsActivePort,
  type ChromeProcessIdentity,
} from "./profileState.js";
import type { BrowserLogger, ResolvedBrowserConfig } from "./types.js";
import { delay } from "./utils.js";

export type ManualChromeOwnerSource = "active-port" | "rediscovered" | "launched";

export type BrowserChrome = ChromeLaunchResult;

export interface ManualChromeOwner {
  readonly chrome: BrowserChrome;
  readonly processIdentity: ChromeProcessIdentity;
  readonly source: ManualChromeOwnerSource;
}

export interface ManualChromeOwnerDeps {
  acquireProfileLock?: typeof acquireProfileRunLock;
  captureIdentity?: typeof captureChromeProcessIdentity;
  cleanupProfileState?: typeof cleanupStaleProfileState;
  discoverExactProfileChrome?: typeof findRunningChromeDebugTargetForProfile;
  isOwnerProcessAlive?: typeof isProcessAlive;
  launch?: typeof launchChrome;
  probe?: typeof verifyDevToolsReachable;
  readIdentity?: typeof readChromeProcessIdentity;
  readPid?: typeof readChromePid;
  readPort?: typeof readDevToolsPort;
  verifyIdentity?: typeof verifyChromeProcessIdentity;
  writeIdentity?: typeof writeChromeProcessIdentity;
  writePid?: typeof writeChromePid;
  writePort?: typeof writeDevToolsActivePort;
}

/**
 * Acquire the one canonical Chrome process for a persistent manual-login profile.
 * Tab leases are deliberately separate: they authorize tabs, never another browser process.
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
    logger,
    sessionId,
  });
  if (!launchLock) {
    throw new Error(`Unable to acquire canonical Chrome owner lock for ${profileDir}`);
  }

  try {
    const existing = await findExistingManualChromeOwner(
      profileDir,
      config.reuseChromeWaitMs,
      logger,
      deps,
    );
    if (existing) return existing;

    const launch = deps.launch ?? launchChrome;
    const chrome = await launch(
      {
        ...config,
        remoteChrome: config.remoteChrome,
      },
      profileDir,
      logger,
    );
    let pid: number;
    let port: number;
    let processIdentity: ChromeProcessIdentity;
    try {
      pid = requirePositiveInteger(chrome.pid, "pid", profileDir);
      port = requirePositiveInteger(chrome.port, "DevTools port", profileDir);
      processIdentity = requireProcessIdentity(chrome.processIdentity, pid, profileDir);
      await persistCanonicalOwner(profileDir, { pid, port, processIdentity }, deps);
    } catch (error) {
      try {
        await chrome.kill();
      } catch {
        // Best effort: preserve the original authority-persistence error.
      }
      await (deps.cleanupProfileState ?? cleanupStaleProfileState)(profileDir, logger, {
        lockRemovalMode: "if_oracle_pid_dead",
      }).catch(() => false);
      throw error;
    }

    logger(`Launched canonical Chrome owner for ${profileDir} (DevTools port ${port}, pid ${pid})`);
    return { chrome, processIdentity, source: "launched" };
  } finally {
    await launchLock.release().catch(() => undefined);
  }
}

async function findExistingManualChromeOwner(
  profileDir: string,
  waitForPortMs: number | undefined,
  logger: BrowserLogger,
  deps: ManualChromeOwnerDeps,
): Promise<ManualChromeOwner | null> {
  const readPort = deps.readPort ?? readDevToolsPort;
  const readPid = deps.readPid ?? readChromePid;
  const readIdentity = deps.readIdentity ?? readChromeProcessIdentity;
  const verifyIdentity = deps.verifyIdentity ?? verifyChromeProcessIdentity;
  const discoverExact = deps.discoverExactProfileChrome ?? findRunningChromeDebugTargetForProfile;
  const probe = deps.probe ?? verifyDevToolsReachable;
  const ownerProcessAlive = deps.isOwnerProcessAlive ?? isProcessAlive;

  let activePort = await readPort(profileDir);
  const waitMs = Math.max(0, waitForPortMs ?? 0);
  if (!activePort && waitMs > 0) {
    const deadline = Date.now() + waitMs;
    logger(`Waiting up to ${formatElapsed(waitMs)} for canonical Chrome owner to appear...`);
    while (!activePort && Date.now() < deadline) {
      await delay(250);
      activePort = await readPort(profileDir);
    }
  }

  const recordedPid = await readPid(profileDir);
  const recordedIdentity = await readIdentity(profileDir);
  const recordedIdentityVerified = Boolean(
    recordedIdentity && (await verifyIdentity(profileDir, recordedIdentity)),
  );
  if (
    activePort &&
    recordedPid &&
    recordedIdentity?.pid === recordedPid &&
    recordedIdentityVerified
  ) {
    const reachable = await probe({ port: activePort });
    if (!reachable.ok) {
      throw new Error(
        `Verified Chrome owner for ${profileDir} is running as pid ${recordedPid}, but DevTools port ${activePort} is unreachable (${reachable.error}); refusing to launch a second browser process`,
      );
    }
    logger(
      `Reusing canonical Chrome owner for ${profileDir} (DevTools port ${activePort}, pid ${recordedPid})`,
    );
    return {
      chrome: reusableChrome(activePort, recordedPid, recordedIdentity),
      processIdentity: recordedIdentity,
      source: "active-port",
    };
  }

  const discovered = await discoverExact(profileDir);
  if (discovered) {
    const pid = requirePositiveInteger(discovered.pid, "rediscovered pid", profileDir);
    const port = requirePositiveInteger(discovered.port, "rediscovered DevTools port", profileDir);
    const reachable = await probe({ port });
    if (!reachable.ok) {
      throw new Error(
        `Exact Chrome owner for ${profileDir} is running as pid ${pid}, but DevTools port ${port} is unreachable (${reachable.error}); refusing to launch a second browser process`,
      );
    }

    const processIdentity =
      recordedIdentity && recordedIdentity.pid === pid && recordedIdentityVerified
        ? recordedIdentity
        : await (deps.captureIdentity ?? captureChromeProcessIdentity)(profileDir, pid);
    requireProcessIdentity(processIdentity, pid, profileDir);
    await persistCanonicalOwner(profileDir, { pid, port, processIdentity }, deps);
    logger(`Rediscovered exact Chrome owner for ${profileDir} (DevTools port ${port}, pid ${pid})`);
    return {
      chrome: reusableChrome(port, pid, processIdentity),
      processIdentity,
      source: "rediscovered",
    };
  }

  if (activePort) {
    const reachable = await probe({ port: activePort });
    if (reachable.ok) {
      throw new Error(
        `DevTools port ${activePort} is reachable for ${profileDir}, but its exact Chrome process/profile owner could not be verified; refusing to launch a second browser process`,
      );
    }
  }
  const possiblyLivePid = recordedIdentity?.pid ?? recordedPid;
  if (possiblyLivePid && ownerProcessAlive(possiblyLivePid)) {
    throw new Error(
      `Recorded Chrome owner pid ${possiblyLivePid} is still alive for ${profileDir}, but no exact reachable profile owner was verified; refusing to launch a second browser process`,
    );
  }

  if (activePort || recordedPid || recordedIdentity) {
    const cleaned = await (deps.cleanupProfileState ?? cleanupStaleProfileState)(
      profileDir,
      logger,
      { lockRemovalMode: "if_oracle_pid_dead" },
    );
    if (!cleaned) {
      throw new Error(
        `Stale Chrome owner state for ${profileDir} could not be cleared safely; refusing to launch a second browser process`,
      );
    }
  }
  return null;
}

async function persistCanonicalOwner(
  profileDir: string,
  owner: { pid: number; port: number; processIdentity: ChromeProcessIdentity },
  deps: ManualChromeOwnerDeps,
): Promise<void> {
  const writePort = deps.writePort ?? writeDevToolsActivePort;
  const writePid = deps.writePid ?? writeChromePid;
  const writeIdentity = deps.writeIdentity ?? writeChromeProcessIdentity;
  const readIdentity = deps.readIdentity ?? readChromeProcessIdentity;
  const readPort = deps.readPort ?? readDevToolsPort;
  const readPid = deps.readPid ?? readChromePid;
  const verifyIdentity = deps.verifyIdentity ?? verifyChromeProcessIdentity;

  requireProcessIdentity(owner.processIdentity, owner.pid, profileDir);
  const persistedIdentity = await readIdentity(profileDir);
  if (!persistedIdentity || !sameChromeProcessIdentity(persistedIdentity, owner.processIdentity)) {
    await writeIdentity(profileDir, owner.processIdentity);
  }
  await writePort(profileDir, owner.port);
  await writePid(profileDir, owner.pid);
  const [persistedPort, persistedPid, identityVerified] = await Promise.all([
    readPort(profileDir),
    readPid(profileDir),
    verifyIdentity(profileDir, owner.processIdentity),
  ]);
  if (persistedPort !== owner.port || persistedPid !== owner.pid || !identityVerified) {
    throw new Error(
      `Failed to persist canonical Chrome owner authority for ${profileDir} (expected pid ${owner.pid}, port ${owner.port}; found pid ${persistedPid ?? "missing"}, port ${persistedPort ?? "missing"}, identity ${identityVerified ? "verified" : "unverified"})`,
    );
  }
}

function reusableChrome(
  port: number,
  pid: number,
  processIdentity: ChromeProcessIdentity,
): BrowserChrome {
  return {
    port,
    pid,
    processIdentity,
    kill: async () => undefined,
    process: undefined,
  } as unknown as BrowserChrome;
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
    !identity.launchNonce
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
