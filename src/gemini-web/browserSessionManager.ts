import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import type {
  BrowserCaptureFinalizationResult,
  BrowserLogger,
  BrowserRunOptions,
  ChromeClient,
} from "../browser/types.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import {
  LocalOwnedBrowserResourceAuthority,
  type BrowserCaptureSettlementMode,
} from "../browser/ownedBrowserResources.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  closeChromeTargetWithExactAuthority,
  connectWithNewTabWithExactAuthority,
} from "../browser/chromeLifecycle.js";
import { resolveBrowserConfig } from "../browser/config.js";
import { acquireManualChromeOwner, type ManualChromeOwner } from "../browser/manualChromeOwner.js";
import {
  captureProfileDirectoryIdentity,
  createChromeProcessLaunchClaim,
} from "../browser/profileState.js";
import { acquireBrowserTabLease } from "../browser/tabLeaseRegistry.js";
import { retainChromeTargetCloseCapability } from "../browser/targetCloseAuthority.js";

export interface GeminiBrowserSession {
  profileDir: string;
  port: number;
  client: ChromeClient;
  targetId: string;
  processIdentity: ManualChromeOwner["processIdentity"];
  runtime: () => BrowserRuntimeMetadata;
  settle: (
    mode: BrowserCaptureSettlementMode,
    pendingRuntime?: BrowserRuntimeMetadata,
  ) => Promise<BrowserCaptureFinalizationResult>;
  close: () => Promise<void>;
}

export interface OpenGeminiBrowserSessionInput {
  browserConfig: BrowserRunOptions["config"];
  keepBrowserDefault: boolean;
  purpose: string;
  log?: BrowserLogger;
  persistRuntime?: (runtime: BrowserRuntimeMetadata) => void | Promise<void>;
}

export async function openGeminiBrowserSession(
  input: OpenGeminiBrowserSessionInput,
): Promise<GeminiBrowserSession> {
  const { browserConfig, keepBrowserDefault, purpose, log, persistRuntime } = input;
  const logger = log ?? (() => {});
  const resolvedConfig = resolveBrowserConfig({
    ...browserConfig,
    manualLogin: true,
    keepBrowser: browserConfig?.keepBrowser ?? keepBrowserDefault,
  });
  const profileDir =
    resolvedConfig.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile");
  const generationId = randomUUID();
  const resourceOwnerId = randomUUID();
  const launchClaim = createChromeProcessLaunchClaim(generationId);
  const ownerDisposition = resolvedConfig.keepBrowser ? "preserve" : "close-on-last-lease";
  const leaseId = randomUUID();
  const targetMarkerUrl = `about:blank#oracle-acquisition=${generationId}`;
  const profileDirectory = await captureProfileDirectoryIdentity(profileDir, { create: true });
  const resources = new LocalOwnedBrowserResourceAuthority({
    ownerId: resourceOwnerId,
    purpose,
    targetLabel: "Owned Gemini",
    userDataDir: profileDir,
    profileDirectoryIdentity: profileDirectory,
    profileKind: "manual-login",
    keepBrowser: resolvedConfig.keepBrowser,
    closeOwnedTargetOnComplete: !resolvedConfig.keepBrowser,
    generationId,
    processOwnerProvenance: "manual-canonical-owner",
    processLaunchClaim: launchClaim,
    processOwnerDisposition: ownerDisposition,
    leaseId,
    targetMarkerUrl,
    logger,
    disconnectErrorPrefix: "Gemini CDP client close failed",
    manualProcessErrorPrefix: `${purpose} could not safely terminate Chrome`,
    ...(persistRuntime
      ? {
          persistRuntime: async (runtime) => await persistRuntime(runtime),
          persistSettlementResult: async (runtime) => await persistRuntime(runtime),
        }
      : {}),
  });
  let owner: ManualChromeOwner | null = null;
  let client: ChromeClient | null = null;
  let targetId: string | null = null;

  try {
    const tabLease = await resources.journalAcquisition({
      resource: "tab-lease",
      acquire: () =>
        acquireBrowserTabLease(profileDir, {
          maxConcurrentTabs: resolvedConfig.maxConcurrentTabs,
          timeoutMs: resolvedConfig.timeoutMs,
          logger,
          sessionId: resourceOwnerId,
          generationId,
          leaseId,
        }),
      authority: (lease) => lease,
    });
    owner = await resources.journalAcquisition({
      resource: "chrome-process",
      acquire: () =>
        acquireManualChromeOwner(profileDir, resolvedConfig, logger, purpose, { launchClaim }),
      authority: (acquiredOwner) => ({ kind: "manual", owner: acquiredOwner }),
    });
    const chrome = owner.chrome;
    const endpointAuthority = owner.endpointAuthority ?? chrome.endpointAuthority;
    if (!endpointAuthority) {
      throw new Error("Gemini Chrome owner has no retained exact endpoint authority.");
    }
    const host = chrome.host ?? "127.0.0.1";
    await tabLease.update({ chromeHost: host, chromePort: chrome.port });
    const connection = await resources.journalAcquisition({
      resource: "chrome-target",
      acquire: async () => {
        const opened = await connectWithNewTabWithExactAuthority(
          endpointAuthority,
          logger,
          targetMarkerUrl,
          { retries: 6 },
        );
        if (!opened.targetId) throw new Error("Failed to create an isolated Gemini browser tab.");
        return opened;
      },
      authority: (opened) => ({
        targetId: opened.targetId as string,
        capability: retainChromeTargetCloseCapability({
          ownerId: resourceOwnerId,
          generationId,
          targetId: opened.targetId as string,
          browserWSEndpoint: endpointAuthority.browserWSEndpoint,
          close: async (closeLogger) => {
            const result = await closeChromeTargetWithExactAuthority({
              authority: endpointAuthority,
              targetId: opened.targetId as string,
              logger: closeLogger,
            });
            if (result.status === "unsafe") throw new Error(result.reason);
            return result;
          },
        }),
        disconnect: () => opened.client.close(),
      }),
    });
    client = connection.client;
    targetId = connection.targetId as string;
    await tabLease.update({
      chromeHost: host,
      chromePort: chrome.port,
      chromeTargetId: targetId,
      tabUrl: targetMarkerUrl,
    });
  } catch (error) {
    const cleanup = await resources.settle("abort");
    if (cleanup.status === "pending") {
      throw new BrowserAutomationError(
        `${error instanceof Error ? error.message : String(error)}; Gemini browser cleanup remains retryable: ${cleanup.error}`,
        { stage: "gemini-browser-session-open", runtime: cleanup.runtime },
        error,
      );
    }
    throw error;
  }

  if (!owner || !client || !targetId) {
    throw new Error("Failed to establish an isolated Gemini browser session.");
  }

  const settle = (
    mode: BrowserCaptureSettlementMode,
    pendingRuntime?: BrowserRuntimeMetadata,
  ): Promise<BrowserCaptureFinalizationResult> => resources.settle(mode, pendingRuntime);

  return {
    profileDir,
    port: owner.chrome.port,
    processIdentity: owner.processIdentity,
    client,
    targetId,
    runtime: () => resources.runtime(),
    settle,
    close: async () => {
      const result = await settle("abort");
      if (result.status === "pending") {
        throw new BrowserAutomationError(
          `Gemini browser session cleanup remains retryable: ${result.error}`,
          { stage: "gemini-browser-cleanup", runtime: result.runtime },
        );
      }
    },
  };
}
