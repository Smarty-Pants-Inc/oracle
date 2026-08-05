import path from "node:path";
import os from "node:os";
import type { BrowserRunOptions, BrowserLogger, ChromeClient } from "../browser/types.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { pendingBrowserCaptureCleanup } from "../browser/runLifecycle.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { connectWithNewTab, closeTab } from "../browser/chromeLifecycle.js";
import { resolveBrowserConfig } from "../browser/config.js";
import {
  acquireManualChromeOwner,
  settleManualChromeOwner,
  type ManualChromeOwner,
} from "../browser/manualChromeOwner.js";
import {
  cleanupStaleProfileState,
  isSafeChromeTerminationOutcome,
  type ChromeProcessIdentity,
  type RecordedChromeTerminationOutcome,
} from "../browser/profileState.js";
import {
  acquireBrowserTabLease,
  retainBrowserTabLeaseTeardownAuthority,
} from "../browser/tabLeaseRegistry.js";

export interface GeminiBrowserSession {
  profileDir: string;
  port: number;
  client: ChromeClient;
  targetId: string;
  processIdentity: ChromeProcessIdentity;
  runtime: () => BrowserRuntimeMetadata;
  close: () => Promise<void>;
}

export interface OpenGeminiBrowserSessionInput {
  browserConfig: BrowserRunOptions["config"];
  keepBrowserDefault: boolean;
  purpose: string;
  log?: BrowserLogger;
}

export async function openGeminiBrowserSession(
  input: OpenGeminiBrowserSessionInput,
): Promise<GeminiBrowserSession> {
  const { browserConfig, keepBrowserDefault, purpose, log } = input;
  const logger = log ?? (() => {});
  const resolvedConfig = resolveBrowserConfig({
    ...browserConfig,
    manualLogin: true,
    keepBrowser: browserConfig?.keepBrowser ?? keepBrowserDefault,
  });
  const profileDir =
    resolvedConfig.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile");
  const tabLease = await acquireBrowserTabLease(profileDir, {
    maxConcurrentTabs: resolvedConfig.maxConcurrentTabs,
    timeoutMs: resolvedConfig.timeoutMs,
    logger,
    sessionId: purpose,
  });

  let owner: ManualChromeOwner;
  try {
    owner = await acquireManualChromeOwner(profileDir, resolvedConfig, logger, purpose);
  } catch (error) {
    try {
      await tabLease.release();
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      const runtime = pendingBrowserCaptureCleanup(
        {
          userDataDir: profileDir,
          chromeProfileRoot: profileDir,
          recoveryCleanupResources: [
            {
              profileDirectoryIdentity: tabLease.profileDirectory,
              userDataDir: profileDir,
              chromeProfileRoot: profileDir,
              tabLease: { id: tabLease.id, profileDirectory: tabLease.profileDirectory },
              recoveryCleanup: {
                ownsTarget: false,
                profileKind: "manual-login",
                keepBrowser: true,
              },
            },
          ],
          controllerPid: process.pid,
        },
        `Browser tab lease release failed: ${message}`,
        "abort",
      ).runtime;
      throw new BrowserAutomationError(
        `Gemini browser owner acquisition failed and lease cleanup remains retryable: ${message}`,
        { stage: "gemini-browser-session-open", runtime },
        error,
      );
    }
    throw error;
  }

  const { chrome, processIdentity } = owner;
  const port = chrome.port;
  const host = chrome.host ?? "127.0.0.1";

  let targetId: string | null = null;
  let client: ChromeClient | null = null;
  let targetClosed = false;
  let clientClosed = false;
  let leaseReleased = false;
  let ownerTerminated = false;
  let profileCleaned = false;
  let closeCompleted = false;
  let closeAttempt: Promise<void> | null = null;
  const teardownAuthority =
    owner.disposition === "close-on-last-lease"
      ? retainBrowserTabLeaseTeardownAuthority(profileDir, tabLease, { logger })
      : null;

  const cleanupFailure = (action: string, cause?: unknown): Error => {
    const detail =
      cause === undefined ? "" : `: ${cause instanceof Error ? cause.message : String(cause)}`;
    return new Error(`Gemini browser session did not settle cleanly: ${action}${detail}`);
  };

  const settleCloseOnLastLeaseOwner = async (): Promise<void> => {
    if (!ownerTerminated) {
      let termination: RecordedChromeTerminationOutcome;
      try {
        termination = await chrome.kill();
      } catch (error) {
        throw cleanupFailure("could not terminate its launched Chrome owner", error);
      }
      if (!isSafeChromeTerminationOutcome(termination)) {
        throw cleanupFailure(`could not safely terminate Chrome: ${termination.reason}`);
      }
      ownerTerminated = true;
    }
    if (!profileCleaned) {
      let cleaned: boolean;
      try {
        cleaned = await cleanupStaleProfileState(profileDir, log, {
          lockRemovalMode: "never",
          expectedProfileIdentity: processIdentity.profileDirectory,
        });
      } catch (error) {
        throw cleanupFailure("could not clean up its terminated Chrome profile", error);
      }
      if (!cleaned) {
        throw cleanupFailure("could not confirm profile cleanup");
      }
      profileCleaned = true;
    }
  };

  const runtime = (): BrowserRuntimeMetadata => {
    const targetCleanupPending = Boolean(targetId && !targetClosed);
    const processCleanupPending = Boolean(
      teardownAuthority && (!ownerTerminated || !profileCleaned),
    );
    const recoveryCleanupPending = targetCleanupPending || !leaseReleased || processCleanupPending;
    const base: BrowserRuntimeMetadata = {
      browserTransport: "cdp",
      chromePid: chrome.pid,
      chromeProcessIdentity: processIdentity,
      chromePort: port,
      chromeHost: host,
      chromeProfileRoot: profileDir,
      userDataDir: profileDir,
      chromeTargetId: targetCleanupPending ? (targetId ?? undefined) : undefined,
      controllerPid: process.pid,
    };
    if (!recoveryCleanupPending) return base;
    return {
      ...base,
      recoveryCleanupResources: [
        {
          chromePid: chrome.pid,
          chromeProcessIdentity: processIdentity,
          profileDirectoryIdentity: processIdentity.profileDirectory,
          chromePort: port,
          chromeHost: host,
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          chromeTargetId: targetCleanupPending ? (targetId ?? undefined) : undefined,
          tabLease: !leaseReleased
            ? { id: tabLease.id, profileDirectory: tabLease.profileDirectory }
            : undefined,
          recoveryCleanup: {
            ownsTarget: targetCleanupPending,
            profileKind: "manual-login",
            keepBrowser: !processCleanupPending,
            closeOwnedTargetOnComplete: targetCleanupPending,
          },
        },
      ],
    };
  };

  const settle = async (): Promise<void> => {
    if (!targetClosed && targetId) {
      let closed: boolean;
      try {
        closed = await closeTab(port, targetId, logger, host);
      } catch (error) {
        throw cleanupFailure(`could not close target ${targetId}`, error);
      }
      if (!closed) {
        throw cleanupFailure(`could not close target ${targetId}`);
      }
      targetClosed = true;
    }
    if (!clientClosed && client) {
      try {
        await client.close();
      } catch (error) {
        throw cleanupFailure("could not close its CDP client", error);
      }
      clientClosed = true;
    }
    if (teardownAuthority) {
      let teardownError: string | null = null;
      const outcome = await teardownAuthority.settle(async () => {
        try {
          await settleCloseOnLastLeaseOwner();
          return true;
        } catch (error) {
          teardownError = error instanceof Error ? error.message : String(error);
          return false;
        }
      });
      leaseReleased = teardownAuthority.leaseReleased;
      if (outcome.status === "preserved") {
        if (teardownError) throw new Error(teardownError);
        throw cleanupFailure(
          outcome.error ?? `browser owner cleanup remains pending (${outcome.reason})`,
        );
      }
    } else if (!leaseReleased) {
      try {
        await tabLease.release();
      } catch (error) {
        throw cleanupFailure("could not release its browser tab lease", error);
      }
      leaseReleased = true;
      const settlement = await settleManualChromeOwner(profileDir, owner, logger);
      if (settlement.status === "unsafe") {
        throw cleanupFailure(
          `could not release its preserved Chrome authority: ${settlement.reason}`,
        );
      }
    }
    closeCompleted = true;
  };

  const close = (): Promise<void> => {
    if (closeCompleted) return Promise.resolve();
    if (closeAttempt) return closeAttempt;
    closeAttempt = settle().finally(() => {
      closeAttempt = null;
    });
    return closeAttempt;
  };

  try {
    await tabLease.update({ chromeHost: host, chromePort: port });
    const connection = await connectWithNewTab(port, logger, "about:blank", host, {
      fallbackToDefault: false,
      retries: 6,
    });
    if (!connection.targetId) {
      throw new Error("Failed to create an isolated Gemini browser tab.");
    }
    client = connection.client;
    targetId = connection.targetId;
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      const pendingRuntime = pendingBrowserCaptureCleanup(runtime(), message, "abort").runtime;
      throw new BrowserAutomationError(
        `${error instanceof Error ? error.message : String(error)}; Gemini browser cleanup remains retryable: ${message}`,
        { stage: "gemini-browser-session-open", runtime: pendingRuntime },
        error,
      );
    }
    throw error;
  }
  if (!client || !targetId) {
    throw new Error("Failed to establish an isolated Gemini browser session.");
  }

  return {
    profileDir,
    port,
    processIdentity,
    client,
    targetId,
    runtime,
    close,
  };
}
