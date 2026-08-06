import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { BrowserAutomationError } from "../oracle/errors.js";
import { launchChrome, type ChromeLaunchResult } from "./chromeLifecycle.js";
import { resolveUserDataBaseDir } from "./localExecutionContext.js";
import { acquireManualChromeOwner } from "./manualChromeOwner.js";
import {
  assertManualLoginProfileReadyForRun,
  defaultManualLoginProfileDir,
} from "./manualLoginProfile.js";
import {
  LocalOwnedBrowserResourceAuthority,
  type LocalOwnedBrowserProcessAuthority,
} from "./ownedBrowserResources.js";
import { createChromeProcessLaunchClaim } from "./chromeProcessLaunchClaim.js";
import { captureProfileDirectoryIdentity, type ChromeOwnerDisposition } from "./profileState.js";
import { acquireBrowserTabLease, type BrowserTabLease } from "./tabLeaseRegistry.js";
import { copyChromeProfile } from "./profileCopy.js";
import { finalizeRecoveredRuntime } from "./reattachCleanup.js";
import type {
  BrowserCaptureFinalizationResult,
  BrowserLogger,
  BrowserRunOptions,
  ResolvedBrowserConfig,
} from "./types.js";

export interface LocalBrowserAcquisitionContext {
  options: BrowserRunOptions;
  config: ResolvedBrowserConfig;
  logger: BrowserLogger;
  usingCopiedProfile: boolean;
}

export interface LocalBrowserAcquisition {
  config: ResolvedBrowserConfig;
  manualLogin: boolean;
  profileIsPreSigned: boolean;
  userDataDir: string;
  effectiveKeepBrowser: boolean;
  resourceAuthority: LocalOwnedBrowserResourceAuthority;
  chrome: ChromeLaunchResult;
  chromeOwnerDisposition: ChromeOwnerDisposition;
  chromeHost: string;
  tabLease: BrowserTabLease | null;
}

export async function acquireLocalBrowserResources({
  options,
  config: initialConfig,
  logger,
  usingCopiedProfile,
}: LocalBrowserAcquisitionContext): Promise<LocalBrowserAcquisition> {
  let config = initialConfig;
  const manualLogin = Boolean(config.manualLogin);
  if (manualLogin && usingCopiedProfile) {
    throw new BrowserAutomationError(
      "--copy-profile cannot be combined with --browser-manual-login: choose either a throwaway copied profile or the persistent manual-login profile.",
      { stage: "profile-config" },
    );
  }

  // Manual-login and copy-profile both start from an already-signed-in profile,
  // so neither clears nor syncs cookies.
  const profileIsPreSigned = manualLogin || usingCopiedProfile;
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : defaultManualLoginProfileDir();
  const userDataDir = manualLogin
    ? manualProfileDir
    : await mkdtemp(path.join(await resolveUserDataBaseDir(), "oracle-browser-"));
  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  const generationId = randomUUID();
  const resourceOwnerId = options.sessionId?.trim() || randomUUID();
  const launchClaim = createChromeProcessLaunchClaim(generationId);
  const ownerDisposition: ChromeOwnerDisposition = effectiveKeepBrowser
    ? "preserve"
    : "close-on-last-lease";
  const leaseId = manualLogin ? randomUUID() : undefined;
  const targetMarkerUrl = `about:blank#oracle-acquisition=${generationId}`;
  let resourceAuthority: LocalOwnedBrowserResourceAuthority | null = null;
  let processAuthority: LocalOwnedBrowserProcessAuthority | null = null;

  try {
    if (manualLogin) {
      await mkdir(userDataDir, { recursive: true });
      logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
      await assertManualLoginProfileReadyForRun({
        userDataDir,
        keepBrowser: effectiveKeepBrowser,
      });
    }

    const profileDirectoryIdentity = await captureProfileDirectoryIdentity(userDataDir);
    resourceAuthority = new LocalOwnedBrowserResourceAuthority({
      ownerId: resourceOwnerId,
      purpose: "Local ChatGPT",
      targetLabel: "Owned Chrome",
      userDataDir,
      profileDirectoryIdentity,
      profileKind: manualLogin ? "manual-login" : usingCopiedProfile ? "copied" : "temporary",
      keepBrowser: effectiveKeepBrowser,
      closeOwnedTargetOnComplete: true,
      generationId,
      processOwnerProvenance: manualLogin ? "manual-canonical-owner" : "temporary-launch",
      processLaunchClaim: launchClaim,
      processOwnerDisposition: ownerDisposition,
      ...(leaseId ? { leaseId } : {}),
      ...(config.browserTabRef ? {} : { targetMarkerUrl }),
      logger,
      ...(options.runtimeHintCb
        ? {
            persistRuntime: async (runtime) => {
              await options.runtimeHintCb?.(runtime, undefined);
              return runtime;
            },
            persistSettlementResult: async (runtime) => {
              await options.runtimeHintCb?.(runtime, undefined);
            },
          }
        : {}),
      settleRemainingResources: (mode, runtime) =>
        finalizeRecoveredRuntime(runtime, logger, { ownerId: resourceOwnerId }, mode),
    });

    if (manualLogin) {
      await resourceAuthority.journalAcquisition({
        resource: "tab-lease",
        acquire: () =>
          acquireBrowserTabLease(userDataDir, {
            maxConcurrentTabs: config.maxConcurrentTabs,
            timeoutMs: config.timeoutMs,
            logger,
            sessionId: resourceOwnerId,
            generationId,
            leaseId,
          }),
        authority: (lease) => lease,
      });
    }

    processAuthority = await resourceAuthority.journalAcquisition({
      resource: "chrome-process",
      acquire: async () => {
        if (config.copyProfileSource) {
          const copiedProfileDirectory = await copyChromeProfile(
            config.copyProfileSource,
            userDataDir,
            config.chromeProfile,
          );
          config = { ...config, chromeProfile: copiedProfileDirectory };
          logger(
            `Seeded temporary Chrome profile ${copiedProfileDirectory} from ${config.copyProfileSource} (copy-profile mode; signed-in session reused without manual login)`,
          );
        } else if (!manualLogin) {
          logger(`Created temporary Chrome profile at ${userDataDir}`);
        }

        if (manualLogin) {
          const owner = await acquireManualChromeOwner(
            userDataDir,
            config,
            logger,
            options.sessionId,
            { launchClaim },
          );
          return { kind: "manual" as const, owner };
        }
        const chrome = await launchChrome(
          { ...config, remoteChrome: config.remoteChrome },
          userDataDir,
          logger,
          { launchClaim },
        );
        return { kind: "temporary" as const, chrome };
      },
      authority: (authority) => authority,
    });
    if (!resourceAuthority || !processAuthority) {
      throw new Error("Chrome acquisition completed without resource authority.");
    }
    const chrome = resourceAuthority.acquiredChrome();
    const chromeOwnerDisposition =
      processAuthority.kind === "manual" ? processAuthority.owner.disposition : ownerDisposition;
    const chromeHost = chrome.host ?? "127.0.0.1";
    const tabLease = resourceAuthority.acquiredLease();
    if (tabLease) {
      await tabLease.update({ chromeHost, chromePort: chrome.port });
    }

    return {
      config,
      manualLogin,
      profileIsPreSigned,
      userDataDir,
      effectiveKeepBrowser,
      resourceAuthority,
      chrome,
      chromeOwnerDisposition,
      chromeHost,
      tabLease,
    };
  } catch (error) {
    if (!resourceAuthority) throw error;
    let cleanup: BrowserCaptureFinalizationResult;
    try {
      cleanup = await resourceAuthority.settle("abort");
    } catch (cleanupError) {
      const cleanupMessage =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new BrowserAutomationError(
        `${error instanceof Error ? error.message : String(error)}; ` +
          `local browser acquisition cleanup remains retryable: ${cleanupMessage}`,
        {
          stage: "browser-acquisition",
          code: "local-acquisition-cleanup-pending",
          runtime: resourceAuthority.runtime(),
          cleanupError: cleanupMessage,
        },
        new AggregateError([error, cleanupError], "Local browser acquisition cleanup failed"),
      );
    }
    if (cleanup.status === "pending") {
      throw new BrowserAutomationError(
        `${error instanceof Error ? error.message : String(error)}; ` +
          `local browser acquisition cleanup remains retryable: ${cleanup.error}`,
        {
          stage: "browser-acquisition",
          code: "local-acquisition-cleanup-pending",
          runtime: cleanup.runtime,
          cleanupError: cleanup.error,
        },
        error,
      );
    }
    throw error;
  }
}
