import path from "node:path";
import os from "node:os";
import type { BrowserRunOptions, BrowserLogger, ChromeClient } from "../browser/types.js";
import { connectWithNewTab, closeTab } from "../browser/chromeLifecycle.js";
import { resolveBrowserConfig } from "../browser/config.js";
import { acquireManualChromeOwner, type ManualChromeOwner } from "../browser/manualChromeOwner.js";
import {
  cleanupStaleProfileState,
  isSafeChromeTerminationOutcome,
  type ChromeProcessIdentity,
  type RecordedChromeTerminationOutcome,
} from "../browser/profileState.js";
import { acquireBrowserTabLease } from "../browser/tabLeaseRegistry.js";

export interface GeminiBrowserSession {
  profileDir: string;
  port: number;
  client: ChromeClient;
  targetId: string;
  processIdentity: ChromeProcessIdentity;
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
  const keepBrowser = Boolean(resolvedConfig.keepBrowser);
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
    await tabLease.release().catch(() => undefined);
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
  let ownerCleanupRequired = false;
  let ownerTerminated = false;
  let profileCleaned = false;
  let closeCompleted = false;
  let closeAttempt: Promise<void> | null = null;

  const cleanupFailure = (action: string, cause?: unknown): Error => {
    const detail =
      cause === undefined ? "" : `: ${cause instanceof Error ? cause.message : String(cause)}`;
    return new Error(`Gemini browser session did not settle cleanly: ${action}${detail}`);
  };

  const settleLaunchedOwner = async (): Promise<void> => {
    if (!ownerCleanupRequired) return;
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
    if (ownerCleanupRequired) {
      await settleLaunchedOwner();
    }
    if (!leaseReleased) {
      try {
        await tabLease.release({
          onRelease: async ({ isLastLease }) => {
            ownerCleanupRequired = !keepBrowser && isLastLease && owner.source === "launched";
            await settleLaunchedOwner();
          },
        });
      } catch (error) {
        throw cleanupFailure("could not release its browser tab lease", error);
      }
      leaseReleased = true;
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
    await close();
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
    close,
  };
}
