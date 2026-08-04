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
  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      const failures: Error[] = [];
      const recordFailure = (error: unknown, action: string): void => {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(new Error(`Gemini browser session ${action}: ${message}`));
      };

      if (targetId) {
        try {
          if (!(await closeTab(port, targetId, logger, host))) {
            failures.push(new Error(`Gemini browser session could not close target ${targetId}.`));
          }
        } catch (error) {
          recordFailure(error, `could not close target ${targetId}`);
        }
      }
      if (client) {
        try {
          await client.close();
        } catch (error) {
          recordFailure(error, "could not close its CDP client");
        }
      }
      try {
        await tabLease.release({
          onRelease: async ({ isLastLease }) => {
            if (keepBrowser || !isLastLease || owner.source !== "launched") return;
            let termination: RecordedChromeTerminationOutcome;
            try {
              termination = await chrome.kill();
            } catch (error) {
              recordFailure(error, "could not terminate its launched Chrome owner");
              return;
            }
            if (!isSafeChromeTerminationOutcome(termination)) {
              failures.push(
                new Error(
                  `Gemini browser session could not safely terminate Chrome: ${termination.reason}`,
                ),
              );
              return;
            }
            try {
              const cleaned = await cleanupStaleProfileState(profileDir, log, {
                lockRemovalMode: "never",
                expectedProfileIdentity: processIdentity.profileDirectory,
              });
              if (!cleaned) {
                failures.push(
                  new Error("Gemini browser session could not confirm profile cleanup."),
                );
              }
            } catch (error) {
              recordFailure(error, "could not clean up its terminated Chrome profile");
            }
          },
        });
      } catch (error) {
        recordFailure(error, "could not release its browser tab lease");
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Gemini browser session did not settle cleanly.");
      }
    })();
    return closePromise;
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
