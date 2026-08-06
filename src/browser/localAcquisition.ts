import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserRecoveryCleanupResourceMetadata } from "../sessionManager.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  launchChrome,
  type ChromeLaunchResult,
  type RetainedChromeEndpointAuthority,
} from "./chromeLifecycle.js";
import {
  acquireManualChromeOwner,
  releaseManualChromeOwnerEndpointAuthority,
  settleManualChromeOwner,
  type ManualChromeOwner,
} from "./manualChromeOwner.js";
import {
  assertManualLoginProfileReadyForRun,
  defaultManualLoginProfileDir,
} from "./manualLoginProfile.js";
import {
  captureProfileDirectoryIdentity,
  createChromeProcessLaunchClaim,
  isSafeChromeTerminationOutcome,
  removeProfileDirectoryIfIdentityMatches,
  type ChromeOwnerDisposition,
  type ChromeProcessLaunchClaim,
  type ProfileDirectoryIdentity,
} from "./profileState.js";
import {
  acquireBrowserTabLease,
  retainBrowserTabLeaseTeardownAuthority,
  type BrowserTabLease,
  type BrowserTabLeaseTeardownAuthority,
} from "./tabLeaseRegistry.js";
import { copyChromeProfile } from "./profileCopy.js";
import { completedBrowserCaptureCleanup, pendingBrowserCaptureCleanup } from "./runLifecycle.js";
import { finalizeRecoveredRuntime } from "./reattachCleanup.js";
import { resolveUserDataBaseDir } from "./localExecutionContext.js";
import { shouldPreserveLocalOwnerForRecovery } from "./coordinatorPolicy.js";
import type { BrowserAcquisitionPendingResource } from "./archiveSettlementCoordinator.js";
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
  acquisitionGenerationId: string;
  acquisitionLaunchClaim: ChromeProcessLaunchClaim;
  acquisitionOwnerDisposition: ChromeOwnerDisposition;
  acquisitionTargetMarkerUrl: string;
  acquisitionProfileIdentity: ProfileDirectoryIdentity;
  chromeOwner: ManualChromeOwner;
  chrome: ChromeLaunchResult;
  chromeOwnerDisposition: ChromeOwnerDisposition;
  chromeHost: string;
  settlementEndpointAuthority: RetainedChromeEndpointAuthority | undefined;
  tabLease: BrowserTabLease | null;
  manualLeaseTeardownAuthority: BrowserTabLeaseTeardownAuthority | null;
}

export async function acquireLocalBrowserResources({
  options,
  config: initialConfig,
  logger,
  usingCopiedProfile,
}: LocalBrowserAcquisitionContext): Promise<LocalBrowserAcquisition> {
  let config = initialConfig;
  const runtimeHintCb = options.runtimeHintCb;
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
  const acquisitionGenerationId = randomUUID();
  const acquisitionLaunchClaim = createChromeProcessLaunchClaim(acquisitionGenerationId);
  let acquisitionOwnerDisposition: ChromeOwnerDisposition = effectiveKeepBrowser
    ? "preserve"
    : "close-on-last-lease";
  const acquisitionLeaseId = manualLogin ? randomUUID() : undefined;
  const acquisitionTargetMarkerUrl = `about:blank#oracle-acquisition=${acquisitionGenerationId}`;
  let acquisitionProfileIdentity: ProfileDirectoryIdentity | null = null;
  let acquisitionPendingResource: BrowserAcquisitionPendingResource = manualLogin
    ? "tab-lease"
    : "chrome-process";
  let tabLease: BrowserTabLease | null = null;

  const buildLocalAcquisitionRuntime = (
    pendingResource: BrowserAcquisitionPendingResource | undefined,
    owner?: ManualChromeOwner | null,
  ): BrowserRuntimeMetadata => {
    const profileIdentity = acquisitionProfileIdentity;
    if (!profileIdentity) {
      throw new Error("Local browser acquisition profile authority is not established.");
    }
    const acquired = owner?.chrome;
    const acquisitionOwnsTarget = pendingResource === "chrome-target";
    const profileKind = manualLogin ? "manual-login" : usingCopiedProfile ? "copied" : "temporary";
    const resource: BrowserRecoveryCleanupResourceMetadata = {
      chromePid: acquired?.pid,
      chromeProcessIdentity: acquired?.processIdentity,
      profileDirectoryIdentity: acquired?.processIdentity?.profileDirectory ?? profileIdentity,
      chromePort: acquired?.port,
      chromeBrowserWSEndpoint: acquired?.endpointAuthority?.browserWSEndpoint,
      chromeHost: acquired?.host ?? "127.0.0.1",
      chromeProfileRoot: userDataDir,
      userDataDir,
      tabLease:
        manualLogin && acquisitionLeaseId
          ? {
              id: tabLease?.id ?? acquisitionLeaseId,
              profileDirectory: tabLease?.profileDirectory ?? profileIdentity,
            }
          : undefined,
      acquisition: {
        generationId: acquisitionGenerationId,
        processOwnerProvenance: manualLogin ? "manual-canonical-owner" : "temporary-launch",
        processLaunchClaim: acquisitionLaunchClaim,
        processOwnerDisposition: acquisitionOwnerDisposition,
        ...(pendingResource ? { pendingResource } : {}),
        ...(config.browserTabRef ? {} : { targetMarkerUrl: acquisitionTargetMarkerUrl }),
      },
      recoveryCleanup: {
        ownsTarget: acquisitionOwnsTarget,
        profileKind,
        keepBrowser: owner
          ? shouldPreserveLocalOwnerForRecovery({
              effectiveKeepBrowser,
              manualLogin,
              ownerDisposition: owner.disposition,
            })
          : acquisitionOwnerDisposition === "preserve",
        closeOwnedTargetOnComplete: acquisitionOwnsTarget,
      },
    };
    return {
      browserTransport: "cdp",
      chromePid: acquired?.pid,
      chromeProcessIdentity: acquired?.processIdentity,
      chromePort: acquired?.port,
      chromeBrowserWSEndpoint: acquired?.endpointAuthority?.browserWSEndpoint,
      chromeHost: acquired?.host ?? "127.0.0.1",
      chromeProfileRoot: userDataDir,
      userDataDir,
      recoveryCleanupResources: [resource],
      recoveryCleanupResult: { status: "pending" },
      controllerPid: process.pid,
    };
  };
  const persistLocalAcquisition = async (
    pendingResource: BrowserAcquisitionPendingResource | undefined,
    owner?: ManualChromeOwner | null,
  ): Promise<void> => {
    if (pendingResource) acquisitionPendingResource = pendingResource;
    if (!runtimeHintCb) return;
    await runtimeHintCb(buildLocalAcquisitionRuntime(pendingResource, owner), undefined);
  };

  let acquiredChrome: ManualChromeOwner | null = null;
  try {
    if (manualLogin) {
      await mkdir(userDataDir, { recursive: true });
      logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
      await assertManualLoginProfileReadyForRun({
        userDataDir,
        keepBrowser: effectiveKeepBrowser,
      });
    }
    acquisitionProfileIdentity = await captureProfileDirectoryIdentity(userDataDir);
    await persistLocalAcquisition(manualLogin ? "tab-lease" : "chrome-process");
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
      tabLease = await acquireBrowserTabLease(userDataDir, {
        maxConcurrentTabs: config.maxConcurrentTabs,
        timeoutMs: config.timeoutMs,
        logger,
        sessionId: options.sessionId,
        leaseId: acquisitionLeaseId,
      });
      await persistLocalAcquisition("chrome-process");
    }

    if (manualLogin) {
      acquiredChrome = await acquireManualChromeOwner(
        userDataDir,
        config,
        logger,
        options.sessionId,
        { launchClaim: acquisitionLaunchClaim },
      );
    } else {
      const chrome = await launchChrome(
        {
          ...config,
          remoteChrome: config.remoteChrome,
        },
        userDataDir,
        logger,
        { launchClaim: acquisitionLaunchClaim },
      );
      acquiredChrome = {
        chrome,
        processIdentity: chrome.processIdentity,
        source: "launched",
        disposition: acquisitionOwnerDisposition,
      };
    }
    if (manualLogin && acquiredChrome) acquisitionOwnerDisposition = acquiredChrome.disposition;
    await persistLocalAcquisition(
      config.browserTabRef ? undefined : "chrome-target",
      acquiredChrome,
    );
  } catch (error) {
    if (!acquiredChrome && !acquisitionProfileIdentity && !manualLogin) {
      acquisitionProfileIdentity = await captureProfileDirectoryIdentity(userDataDir).catch(
        () => null,
      );
    }
    if (!acquiredChrome && acquisitionProfileIdentity) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      const abortRuntime = pendingBrowserCaptureCleanup(
        buildLocalAcquisitionRuntime(acquisitionPendingResource),
        failureMessage,
        "abort",
      ).runtime;
      const recoveryErrors: unknown[] = [];
      try {
        await runtimeHintCb?.(abortRuntime, undefined);
      } catch (persistenceError) {
        recoveryErrors.push(persistenceError);
      }

      let recovery: BrowserCaptureFinalizationResult | null = null;
      try {
        recovery = await finalizeRecoveredRuntime(abortRuntime, logger, {}, "abort");
      } catch (cleanupError) {
        recoveryErrors.push(cleanupError);
      }
      if (recovery) {
        try {
          await runtimeHintCb?.(recovery.runtime, undefined);
        } catch (persistenceError) {
          recoveryErrors.push(persistenceError);
        }
        if (recovery.status === "pending") {
          recoveryErrors.push(new Error(recovery.error));
        }
      }

      if (recoveryErrors.length > 0) {
        const cleanupMessage = recoveryErrors
          .map((recoveryError) =>
            recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          )
          .join("; ");
        const recoveryRuntime = recovery?.runtime ?? abortRuntime;
        throw new BrowserAutomationError(
          `${failureMessage}; local browser acquisition cleanup remains retryable: ${cleanupMessage}`,
          {
            stage: "browser-acquisition",
            code: "local-acquisition-cleanup-pending",
            runtime: recoveryRuntime,
            cleanupError: cleanupMessage,
          },
          new AggregateError(
            [error, ...recoveryErrors],
            "Local browser acquisition cleanup failed",
          ),
        );
      }
      throw error;
    }
    const acquiredAbortRuntime =
      acquiredChrome && acquisitionProfileIdentity
        ? pendingBrowserCaptureCleanup(
            buildLocalAcquisitionRuntime("chrome-process", acquiredChrome),
            error instanceof Error ? error.message : String(error),
            "abort",
          ).runtime
        : null;
    const acquisitionJournalErrors: unknown[] = [];
    if (acquiredAbortRuntime) {
      try {
        await runtimeHintCb?.(acquiredAbortRuntime, undefined);
      } catch (persistenceError) {
        acquisitionJournalErrors.push(persistenceError);
      }
    }
    const cleanupErrors: unknown[] = [];
    if (manualLogin && acquiredChrome && tabLease) {
      if (!effectiveKeepBrowser && acquiredChrome.disposition === "close-on-last-lease") {
        const ownerForCleanup = acquiredChrome;
        const teardown = retainBrowserTabLeaseTeardownAuthority(userDataDir, tabLease, {
          logger,
          onActiveLeaseHandoff: () => releaseManualChromeOwnerEndpointAuthority(ownerForCleanup),
        });
        let ownerError: string | null = null;
        try {
          const outcome = await teardown.settle(async () => {
            const settlement = await settleManualChromeOwner(userDataDir, ownerForCleanup, logger);
            if (settlement.status === "unsafe") {
              ownerError = settlement.reason;
              return false;
            }
            return true;
          });
          if (teardown.leaseReleased) tabLease = null;
          if (outcome.status === "preserved") {
            cleanupErrors.push(ownerError ?? outcome.error ?? outcome.reason);
          }
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      } else {
        const handle = tabLease;
        try {
          await handle.release();
          tabLease = null;
        } catch (releaseError) {
          cleanupErrors.push(releaseError);
        }
        if (effectiveKeepBrowser && acquiredChrome.disposition === "close-on-last-lease") {
          try {
            await releaseManualChromeOwnerEndpointAuthority(acquiredChrome);
          } catch (releaseError) {
            cleanupErrors.push(releaseError);
          }
        } else {
          const settlement = await settleManualChromeOwner(userDataDir, acquiredChrome, logger);
          if (settlement.status === "unsafe") cleanupErrors.push(settlement.reason);
        }
      }
    } else if (tabLease) {
      const handle = tabLease;
      try {
        await handle.release();
        tabLease = null;
      } catch (releaseError) {
        cleanupErrors.push(releaseError);
      }
    }
    if (acquiredChrome && !manualLogin) {
      const termination = await acquiredChrome.chrome.kill().catch((terminationError) => ({
        status: "unsafe" as const,
        pid: acquiredChrome?.chrome.pid ?? -1,
        reason:
          terminationError instanceof Error ? terminationError.message : String(terminationError),
      }));
      if (isSafeChromeTerminationOutcome(termination)) {
        const removed = await removeProfileDirectoryIfIdentityMatches(
          userDataDir,
          acquiredChrome.processIdentity.profileDirectory,
        ).catch(() => false);
        if (!removed) cleanupErrors.push(`Profile removal was not confirmed: ${userDataDir}`);
      } else {
        cleanupErrors.push(termination.reason);
      }
    } else if (!acquiredChrome && usingCopiedProfile) {
      cleanupErrors.push(
        `Copy-profile acquisition failed without a confirmed safe Chrome termination outcome; preserving ${userDataDir}`,
      );
    }
    if (cleanupErrors.length > 0) {
      let cleanupMessage = cleanupErrors
        .map((cleanupError) =>
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        )
        .join("; ");
      let runtime = acquiredAbortRuntime
        ? pendingBrowserCaptureCleanup(acquiredAbortRuntime, cleanupMessage, "abort").runtime
        : pendingBrowserCaptureCleanup(
            buildLocalAcquisitionRuntime(
              config.browserTabRef ? "chrome-process" : "chrome-target",
              acquiredChrome,
            ),
            cleanupMessage,
            "abort",
          ).runtime;
      if (acquiredAbortRuntime) {
        try {
          await runtimeHintCb?.(runtime, undefined);
        } catch (persistenceError) {
          cleanupErrors.push(persistenceError);
          cleanupMessage = cleanupErrors
            .map((cleanupError) =>
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            )
            .join("; ");
          runtime = pendingBrowserCaptureCleanup(
            acquiredAbortRuntime,
            cleanupMessage,
            "abort",
          ).runtime;
        }
      }
      throw new BrowserAutomationError(
        `${error instanceof Error ? error.message : String(error)}; local browser acquisition cleanup remains retryable: ${cleanupMessage}`,
        {
          stage: "browser-acquisition",
          code: "local-acquisition-cleanup-pending",
          runtime,
          cleanupError: cleanupMessage,
        },
        new AggregateError([error, ...cleanupErrors], "Local browser acquisition cleanup failed"),
      );
    }
    if (acquiredAbortRuntime) {
      const completedRuntime = completedBrowserCaptureCleanup(acquiredAbortRuntime).runtime;
      try {
        await runtimeHintCb?.(completedRuntime, undefined);
      } catch (persistenceError) {
        const persistenceMessage =
          persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
        throw new BrowserAutomationError(
          `${error instanceof Error ? error.message : String(error)}; local browser acquisition cleanup completed but its terminal journal could not be persisted: ${persistenceMessage}`,
          {
            stage: "browser-acquisition",
            code: "local-acquisition-completion-persistence-failed",
            runtime: completedRuntime,
            cleanupError: persistenceMessage,
          },
          new AggregateError(
            [error, ...acquisitionJournalErrors, persistenceError],
            "Local browser acquisition completion persistence failed",
          ),
        );
      }
    }
    throw error;
  }

  if (!acquiredChrome) {
    throw new Error("Chrome acquisition completed without an owner record.");
  }
  if (!acquisitionProfileIdentity) {
    throw new Error("Chrome acquisition completed without profile authority.");
  }
  const acquiredChromeOwner = acquiredChrome;
  const chrome = acquiredChromeOwner.chrome;
  const chromeHost = chrome.host ?? "127.0.0.1";
  const settlementEndpointAuthority =
    acquiredChromeOwner.endpointAuthority ?? chrome.endpointAuthority;
  if (tabLease) {
    await tabLease.update({
      chromeHost,
      chromePort: chrome.port,
    });
  }
  const manualLeaseTeardownAuthority =
    manualLogin && tabLease
      ? retainBrowserTabLeaseTeardownAuthority(userDataDir, tabLease, {
          logger,
          onActiveLeaseHandoff: () =>
            releaseManualChromeOwnerEndpointAuthority(acquiredChromeOwner),
        })
      : null;

  return {
    config,
    manualLogin,
    profileIsPreSigned,
    userDataDir,
    effectiveKeepBrowser,
    acquisitionGenerationId,
    acquisitionLaunchClaim,
    acquisitionOwnerDisposition,
    acquisitionTargetMarkerUrl,
    acquisitionProfileIdentity,
    chromeOwner: acquiredChromeOwner,
    chrome,
    chromeOwnerDisposition: acquiredChromeOwner.disposition,
    chromeHost,
    settlementEndpointAuthority,
    tabLease,
    manualLeaseTeardownAuthority,
  };
}
