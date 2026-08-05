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
  OwnedBrowserResourceTransaction,
  completedBrowserCaptureCleanup,
  pendingBrowserCaptureCleanup,
  projectBrowserCaptureCleanupRuntime,
  type BrowserCaptureSettlementMode,
} from "../browser/ownedBrowserResources.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { connectWithNewTab, closeTab } from "../browser/chromeLifecycle.js";
import { resolveBrowserConfig } from "../browser/config.js";
import {
  acquireManualChromeOwner,
  releaseManualChromeOwnerEndpointAuthority,
  settleManualChromeOwner,
  type ManualChromeOwner,
} from "../browser/manualChromeOwner.js";
import {
  captureProfileDirectoryIdentity,
  createChromeProcessLaunchClaim,
} from "../browser/profileState.js";
import {
  acquireBrowserTabLease,
  retainBrowserTabLeaseTeardownAuthority,
  type BrowserTabLease,
  type BrowserTabLeaseTeardownAuthority,
} from "../browser/tabLeaseRegistry.js";

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

function manualOwnerCleanupError(owner: ManualChromeOwner, reason: string): string {
  return owner.source === "launched"
    ? `Gemini launched browser owner could not safely terminate Chrome: ${reason}`
    : `Gemini browser owner cleanup remains unsafe: ${reason}`;
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
  const launchClaim = createChromeProcessLaunchClaim(generationId);
  const ownerDisposition = resolvedConfig.keepBrowser ? "preserve" : "close-on-last-lease";
  const leaseId = randomUUID();
  const targetMarkerUrl = `about:blank#oracle-acquisition=${generationId}`;
  let profileDirectory = await captureProfileDirectoryIdentity(profileDir);
  let tabLease: BrowserTabLease | null = null;
  let owner: ManualChromeOwner | null = null;
  let teardownAuthority: BrowserTabLeaseTeardownAuthority | null = null;
  let targetId: string | null = null;
  let client: ChromeClient | null = null;
  let targetClosed = false;
  let clientClosed = false;
  let leaseReleased = false;
  let ownerSettled = false;

  const runtime = (
    pendingResource?: "tab-lease" | "chrome-process" | "chrome-target",
  ): BrowserRuntimeMetadata => {
    const chrome = owner?.chrome;
    const targetCleanupPending = Boolean(
      (targetId && !targetClosed) || pendingResource === "chrome-target",
    );
    const resourceCleanupPending = Boolean(
      pendingResource || targetCleanupPending || !leaseReleased || (owner && !ownerSettled),
    );
    const base: BrowserRuntimeMetadata = {
      browserTransport: "cdp",
      chromePid: chrome?.pid,
      chromeProcessIdentity: owner?.processIdentity,
      chromePort: chrome?.port,
      chromeBrowserWSEndpoint: chrome?.endpointAuthority?.browserWSEndpoint,
      chromeHost: chrome?.host ?? "127.0.0.1",
      chromeProfileRoot: profileDir,
      userDataDir: profileDir,
      chromeTargetId: targetCleanupPending ? (targetId ?? undefined) : undefined,
      controllerPid: process.pid,
    };
    if (!resourceCleanupPending) return base;
    return {
      ...base,
      recoveryCleanupResources: [
        {
          chromePid: chrome?.pid,
          chromeProcessIdentity: owner?.processIdentity,
          profileDirectoryIdentity: owner?.processIdentity.profileDirectory ?? profileDirectory,
          chromePort: chrome?.port,
          chromeBrowserWSEndpoint: chrome?.endpointAuthority?.browserWSEndpoint,
          chromeHost: chrome?.host ?? "127.0.0.1",
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          chromeTargetId: targetCleanupPending ? (targetId ?? undefined) : undefined,
          tabLease: !leaseReleased
            ? {
                id: tabLease?.id ?? leaseId,
                profileDirectory: tabLease?.profileDirectory ?? profileDirectory,
              }
            : undefined,
          acquisition: {
            generationId,
            processOwnerProvenance: "manual-canonical-owner",
            processLaunchClaim: launchClaim,
            processOwnerDisposition: ownerDisposition,
            ...(pendingResource ? { pendingResource } : {}),
            targetMarkerUrl,
          },
          recoveryCleanup: {
            ownsTarget: targetCleanupPending,
            profileKind: "manual-login",
            keepBrowser: owner ? owner.disposition === "preserve" : ownerDisposition === "preserve",
            closeOwnedTargetOnComplete: targetCleanupPending,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
  };

  const settleResources = async (
    mode: BrowserCaptureSettlementMode,
    pendingRuntime: BrowserRuntimeMetadata,
  ): Promise<BrowserCaptureFinalizationResult> => {
    const errors: string[] = [];
    const cleanup = pendingRuntime.recoveryCleanupResources?.[0]?.recoveryCleanup;
    const shouldCloseTarget =
      cleanup?.ownsTarget === true &&
      (mode === "abort" || cleanup.closeOwnedTargetOnComplete === true);
    if (
      mode === "finalize" &&
      cleanup?.ownsTarget === true &&
      typeof cleanup.closeOwnedTargetOnComplete !== "boolean"
    ) {
      return pendingBrowserCaptureCleanup(
        pendingRuntime,
        "Owned Gemini target finalize disposition is missing",
        mode,
      );
    }
    if (shouldCloseTarget && targetId && !targetClosed) {
      try {
        const chrome = owner?.chrome;
        const closed = chrome
          ? await closeTab(chrome.port, targetId, logger, chrome.host ?? "127.0.0.1")
          : false;
        if (!closed) errors.push(`Gemini target close was not confirmed: ${targetId}`);
        else targetClosed = true;
      } catch (error) {
        errors.push(
          `Gemini target close failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (errors.length === 0 && client && !clientClosed) {
      try {
        await client.close();
        clientClosed = true;
      } catch (error) {
        errors.push(
          `Gemini CDP client close failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (
      errors.length === 0 &&
      tabLease &&
      (!leaseReleased || Boolean(teardownAuthority && owner && !ownerSettled))
    ) {
      if (teardownAuthority && owner) {
        let ownerError: string | null = null;
        const ownerForSettlement = owner;
        const outcome = await teardownAuthority.settle(async () => {
          const settlement = await settleManualChromeOwner(profileDir, ownerForSettlement, logger);
          if (settlement.status === "unsafe") {
            ownerError = manualOwnerCleanupError(ownerForSettlement, settlement.reason);
            return false;
          }
          ownerSettled = true;
          return true;
        });
        leaseReleased = teardownAuthority.leaseReleased;
        if (outcome.status === "preserved") {
          errors.push(ownerError ?? outcome.error ?? outcome.reason);
        } else if (outcome.disposition === "active-lease-handoff") {
          ownerSettled = true;
        }
      } else {
        try {
          await tabLease.release();
          leaseReleased = true;
        } catch (error) {
          errors.push(
            `Gemini browser lease release failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (leaseReleased && owner && !ownerSettled) {
          const settlement = await settleManualChromeOwner(profileDir, owner, logger);
          if (settlement.status === "unsafe") {
            errors.push(manualOwnerCleanupError(owner, settlement.reason));
          } else ownerSettled = true;
        }
      }
    }
    if (errors.length === 0 && !teardownAuthority && leaseReleased && owner && !ownerSettled) {
      const settlement = await settleManualChromeOwner(profileDir, owner, logger);
      if (settlement.status === "unsafe") {
        errors.push(manualOwnerCleanupError(owner, settlement.reason));
      } else ownerSettled = true;
    }
    const resourceRuntime = runtime();
    return errors.length > 0
      ? pendingBrowserCaptureCleanup(resourceRuntime, [...new Set(errors)].join("; "), mode)
      : completedBrowserCaptureCleanup(resourceRuntime);
  };

  const resources = new OwnedBrowserResourceTransaction(
    {
      ...(persistRuntime
        ? {
            persistRuntime: async (nextRuntime) => persistRuntime(nextRuntime),
            persistSettlementResult: async (nextRuntime) => persistRuntime(nextRuntime),
          }
        : {}),
      settleResources,
    },
    runtime(),
  );

  try {
    tabLease = await resources.journalAcquisition({
      intentRuntime: runtime("tab-lease"),
      acquire: () =>
        acquireBrowserTabLease(profileDir, {
          maxConcurrentTabs: resolvedConfig.maxConcurrentTabs,
          timeoutMs: resolvedConfig.timeoutMs,
          logger,
          sessionId: purpose,
          leaseId,
        }),
      acquiredRuntime: (acquiredLease) => {
        tabLease = acquiredLease;
        profileDirectory = acquiredLease.profileDirectory;
        return runtime();
      },
    });
    owner = await resources.journalAcquisition({
      intentRuntime: runtime("chrome-process"),
      acquire: () =>
        acquireManualChromeOwner(profileDir, resolvedConfig, logger, purpose, { launchClaim }),
      acquiredRuntime: (acquiredOwner) => {
        owner = acquiredOwner;
        return runtime();
      },
    });
    if (owner.disposition === "close-on-last-lease") {
      const ownerForHandoff = owner;
      teardownAuthority = retainBrowserTabLeaseTeardownAuthority(profileDir, tabLease, {
        logger,
        onActiveLeaseHandoff: () => releaseManualChromeOwnerEndpointAuthority(ownerForHandoff),
      });
    }
    const chrome = owner.chrome;
    const host = chrome.host ?? "127.0.0.1";
    await tabLease.update({ chromeHost: host, chromePort: chrome.port });
    const connection = await resources.journalAcquisition({
      intentRuntime: runtime("chrome-target"),
      acquire: async () => {
        const opened = await connectWithNewTab(chrome.port, logger, targetMarkerUrl, host, {
          fallbackToDefault: false,
          retries: 6,
        });
        if (!opened.targetId) throw new Error("Failed to create an isolated Gemini browser tab.");
        return { client: opened.client, targetId: opened.targetId };
      },
      acquiredRuntime: (opened) => {
        client = opened.client;
        targetId = opened.targetId;
        return runtime();
      },
    });
    client = connection.client;
    targetId = connection.targetId;
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

  const settle = async (
    mode: BrowserCaptureSettlementMode,
    pendingRuntime?: BrowserRuntimeMetadata,
  ): Promise<BrowserCaptureFinalizationResult> => {
    const currentRuntime = resources.runtime();
    if (
      pendingRuntime &&
      currentRuntime.recoveryCleanupResources?.length &&
      !currentRuntime.recoveryCleanupResult?.settlementMode
    ) {
      resources.replaceRuntime(projectBrowserCaptureCleanupRuntime(pendingRuntime, runtime()));
    }
    return resources.settle(mode);
  };

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
