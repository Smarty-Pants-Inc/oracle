import path from "node:path";
import type { BrowserRecoveryCleanupResourceMetadata } from "../sessionManager.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import {
  retainChromeEndpointAuthority,
  type RetainedChromeEndpointAuthority,
} from "./chromeLifecycle.js";
import {
  captureChromeProcessIdentity,
  inspectChromeProcessIdentity,
  sameChromeProcessIdentity,
  type ChromeProcessIdentity,
} from "./chromeProcessIdentity.js";
import {
  inspectRunningChromeProcessesForLaunchClaim,
  type ChromeLaunchClaimProcessDiscovery,
} from "./chromeProcessDiscovery.js";
import {
  parseChromeProcessLaunchClaim,
  sameChromeProcessLaunchClaim,
} from "./chromeProcessLaunchClaim.js";
import {
  acquireProfileRunLock,
  isSafeChromeTerminationOutcome,
  readOracleChromeOwner,
  sameProfileDirectoryIdentity,
  terminateRecordedChromeForProfile,
  verifyChromeProcessIdentity,
  verifyProfileDirectoryIdentity,
  writeOracleChromeOwner,
  type OracleChromeOwnerRecord,
  type RecordedChromeTerminationOutcome,
  type ProfileRunLock,
} from "./profileState.js";
import {
  chromeProcessIdentityKey,
  cleanupProfileAbsent,
  physicalProfileDirectoryIdentity,
} from "./recoveryCleanupIdentity.js";
import type {
  ProcessAcquisitionReconciliationResult,
  ReattachCleanupDeps,
  RecoveryCleanupEntry,
} from "./reattachCleanupTypes.js";
import { inferPortFromBrowserWSEndpoint } from "./reattachRuntime.js";
import type { BrowserLogger } from "./types.js";
type PendingProcessAcquisitionResolution =
  | { status: "resolved"; resource: BrowserRecoveryCleanupResourceMetadata }
  | { status: "settled" }
  | { status: "pending"; resource: BrowserRecoveryCleanupResourceMetadata; error: string };
export type PersistedLocalEndpointBinding =
  | { status: "gone" }
  | {
      status: "bound";
      host: string;
      port: number;
      browserWSEndpoint: string;
      authority: RetainedChromeEndpointAuthority;
    };

// A failed release can be retried on the exact same CDP authority while this
// controller remains alive. The durable acquisition marker carries the
// identity and endpoint needed to re-bind after a restart.
const pendingAcquisitionEndpointReleases = new Map<string, RetainedChromeEndpointAuthority>();

function acquisitionEndpointReleaseKey(processIdentity: ChromeProcessIdentity): string {
  return JSON.stringify(chromeProcessIdentityKey(processIdentity));
}

function completeProcessAcquisition(
  resource: BrowserRecoveryCleanupResourceMetadata,
): BrowserRecoveryCleanupResourceMetadata {
  const acquisition = resource.acquisition;
  if (!acquisition?.generationId) {
    const { acquisition: _invalidAcquisition, ...resourceWithoutAcquisition } = resource;
    return resourceWithoutAcquisition;
  }
  const { pendingResource: _pendingResource, ...completedAcquisition } = acquisition;
  return { ...resource, acquisition: completedAcquisition };
}

async function settleAcquisitionEndpointRelease(
  resource: BrowserRecoveryCleanupResourceMetadata,
  authority: RetainedChromeEndpointAuthority,
): Promise<PendingProcessAcquisitionResolution> {
  const processIdentity = resource.chromeProcessIdentity;
  if (!processIdentity) {
    return {
      status: "pending",
      resource,
      error: "Chrome process acquisition endpoint release has no exact process identity",
    };
  }
  const key = acquisitionEndpointReleaseKey(processIdentity);
  try {
    await authority.release();
    pendingAcquisitionEndpointReleases.delete(key);
    return { status: "resolved", resource: completeProcessAcquisition(resource) };
  } catch (error) {
    pendingAcquisitionEndpointReleases.set(key, authority);
    return {
      status: "pending",
      resource,
      error: `Exact Chrome endpoint release failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function retryPendingAcquisitionEndpointRelease(
  resource: BrowserRecoveryCleanupResourceMetadata,
  deps: ReattachCleanupDeps,
): Promise<PendingProcessAcquisitionResolution> {
  const processIdentity = resource.chromeProcessIdentity;
  if (!processIdentity) {
    return {
      status: "pending",
      resource,
      error: "Chrome process acquisition endpoint release has no exact process identity",
    };
  }
  const retained = pendingAcquisitionEndpointReleases.get(
    acquisitionEndpointReleaseKey(processIdentity),
  );
  if (retained) return settleAcquisitionEndpointRelease(resource, retained);

  try {
    const binding = await bindPersistedLocalEndpoint(resource, deps);
    if (binding.status === "gone") {
      return { status: "resolved", resource: completeProcessAcquisition(resource) };
    }
    return settleAcquisitionEndpointRelease(
      {
        ...resource,
        chromeHost: binding.host,
        chromePort: binding.port,
        chromeBrowserWSEndpoint: binding.browserWSEndpoint,
      },
      binding.authority,
    );
  } catch (error) {
    return {
      status: "pending",
      resource,
      error: `Chrome process acquisition endpoint release authentication failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
export async function bindPersistedLocalEndpoint(
  resource: BrowserRecoveryCleanupResourceMetadata,
  deps: ReattachCleanupDeps,
): Promise<PersistedLocalEndpointBinding> {
  const processIdentity = resource.chromeProcessIdentity;
  const processProfile = physicalProfileDirectoryIdentity(processIdentity?.profileDirectory);
  const resourceProfile = physicalProfileDirectoryIdentity(resource.profileDirectoryIdentity);
  if (!processIdentity || !processProfile) {
    throw new Error("Local Chrome cleanup has no exact process/profile identity");
  }
  if (resourceProfile && !sameProfileDirectoryIdentity(resourceProfile, processProfile)) {
    throw new Error("Local Chrome cleanup profile identities disagree");
  }
  if (
    resource.userDataDir &&
    resource.chromeProfileRoot &&
    path.resolve(resource.userDataDir) !== path.resolve(resource.chromeProfileRoot)
  ) {
    throw new Error("Local Chrome cleanup profile paths disagree");
  }
  const profileDir =
    resource.userDataDir ?? resource.chromeProfileRoot ?? processProfile.canonicalPath;
  if (
    !(await (deps.verifyProfileDirectoryIdentity ?? verifyProfileDirectoryIdentity)(
      profileDir,
      processProfile,
    ))
  ) {
    throw new Error("Local Chrome cleanup physical profile generation could not be verified");
  }
  const inspectProcess = deps.inspectChromeProcessIdentity ?? inspectChromeProcessIdentity;
  const inspection = await inspectProcess(profileDir, processIdentity);
  if (inspection === "exited") {
    const owner = await (deps.readOracleChromeOwner ?? readOracleChromeOwner)(profileDir);
    if (owner && !sameChromeProcessIdentity(owner.processIdentity, processIdentity)) {
      const replacementInspection = await inspectProcess(profileDir, owner.processIdentity);
      if (replacementInspection !== "exited") {
        throw new Error(
          "Local Chrome cleanup profile is owned by a replacement process generation",
        );
      }
    }
    return { status: "gone" };
  }
  if (inspection !== "current") {
    throw new Error("Local Chrome cleanup process generation could not be authenticated");
  }

  const endpoint = resource.chromeBrowserWSEndpoint
    ? new URL(resource.chromeBrowserWSEndpoint)
    : null;
  const host = resource.chromeHost ?? endpoint?.hostname ?? "127.0.0.1";
  let port =
    resource.chromePort ?? inferPortFromBrowserWSEndpoint(resource.chromeBrowserWSEndpoint);
  if (!port) {
    const owner = await (deps.readOracleChromeOwner ?? readOracleChromeOwner)(profileDir);
    if (!owner || !sameChromeProcessIdentity(owner.processIdentity, processIdentity)) {
      throw new Error("Local Chrome cleanup has no exact DevTools endpoint authority");
    }
    port = owner.port;
  }
  const authority = await (deps.retainChromeEndpointAuthority ?? retainChromeEndpointAuthority)({
    host,
    port,
    browserWSEndpoint: resource.chromeBrowserWSEndpoint,
    userDataDir: profileDir,
    processIdentity,
  });
  return {
    status: "bound",
    host,
    port,
    browserWSEndpoint: authority.browserWSEndpoint,
    authority,
  };
}

export function requiresExactLocalTargetBinding(
  resource: BrowserRecoveryCleanupResourceMetadata,
): boolean {
  if (resource.chromeProcessIdentity || resource.recoveryCleanup.profileKind !== "none") {
    return true;
  }
  let host = resource.chromeHost;
  if (!host && resource.chromeBrowserWSEndpoint) {
    try {
      host = new URL(resource.chromeBrowserWSEndpoint).hostname;
    } catch {
      return true;
    }
  }
  if (!host) return true;
  const normalizedHost = host.toLowerCase();
  return (
    normalizedHost === "localhost" ||
    normalizedHost === "localhost." ||
    normalizedHost.startsWith("127.") ||
    normalizedHost === "::1" ||
    normalizedHost === "[::1]"
  );
}

async function reconcilePendingProcessAcquisition(
  resource: BrowserRecoveryCleanupResourceMetadata,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps,
): Promise<PendingProcessAcquisitionResolution> {
  const acquisition = resource.acquisition;
  if (acquisition?.pendingResource !== "chrome-process") {
    return { status: "resolved", resource };
  }
  const completeAcquisition = (
    next: BrowserRecoveryCleanupResourceMetadata,
  ): BrowserRecoveryCleanupResourceMetadata => completeProcessAcquisition(next);

  const provenance = acquisition.processOwnerProvenance;
  if (provenance !== "temporary-launch" && provenance !== "manual-canonical-owner") {
    return {
      status: "pending",
      resource,
      error: "Chrome process acquisition provenance is missing or invalid",
    };
  }
  const launchClaim = parseChromeProcessLaunchClaim(acquisition.processLaunchClaim);
  if (!launchClaim || launchClaim.generationId !== acquisition.generationId) {
    return {
      status: "pending",
      resource,
      error: "Chrome process acquisition launch claim is missing or invalid",
    };
  }
  const disposition = acquisition.processOwnerDisposition;
  if (disposition !== "preserve" && disposition !== "close-on-last-lease") {
    return {
      status: "pending",
      resource,
      error: "Chrome process acquisition owner disposition is missing or invalid",
    };
  }
  const profileDir = resource.userDataDir;
  const expectedProfile = physicalProfileDirectoryIdentity(resource.profileDirectoryIdentity);
  if (!profileDir || !expectedProfile) {
    return {
      status: "pending",
      resource,
      error: "Chrome process acquisition profile authority is incomplete",
    };
  }
  if (
    !(await (deps.verifyProfileDirectoryIdentity ?? verifyProfileDirectoryIdentity)(
      profileDir,
      expectedProfile,
    ))
  ) {
    if (await cleanupProfileAbsent(profileDir)) return { status: "settled" };
    return {
      status: "pending",
      resource,
      error: "Chrome process acquisition profile authority changed",
    };
  }
  if (
    resource.chromeProcessIdentity &&
    sameChromeProcessLaunchClaim(resource.chromeProcessIdentity.launchClaim, launchClaim)
  ) {
    return retryPendingAcquisitionEndpointRelease(resource, deps);
  }

  let promotionLock: ProfileRunLock | null;
  try {
    promotionLock = await (deps.acquireProfileRunLock ?? acquireProfileRunLock)(profileDir, {
      timeoutMs: 30_000,
      logger,
    });
  } catch (error) {
    return {
      status: "pending",
      resource,
      error: `Chrome process acquisition owner promotion lock failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!promotionLock) {
    return {
      status: "pending",
      resource,
      error: "Chrome process acquisition owner promotion lock was unavailable",
    };
  }
  if (!sameProfileDirectoryIdentity(promotionLock.profileDirectory, expectedProfile)) {
    await promotionLock.release().catch((error: unknown) => {
      logger(
        `Failed to release mismatched Chrome owner promotion lock: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return {
      status: "pending",
      resource,
      error: "Chrome process acquisition profile changed before owner promotion",
    };
  }

  try {
    let owner: OracleChromeOwnerRecord | null;
    try {
      owner = await (deps.readOracleChromeOwner ?? readOracleChromeOwner)(profileDir);
    } catch (error) {
      return {
        status: "pending",
        resource,
        error: `Chrome process acquisition owner lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (owner) {
      if (!sameProfileDirectoryIdentity(owner.processIdentity.profileDirectory, expectedProfile)) {
        return {
          status: "pending",
          resource,
          error: "Chrome process acquisition owner profile does not match the recorded profile",
        };
      }

      const recordedOwner = owner;
      const processIdentity = recordedOwner.processIdentity;
      if (
        provenance === "temporary-launch" &&
        !sameChromeProcessLaunchClaim(processIdentity.launchClaim, launchClaim)
      ) {
        return {
          status: "pending",
          resource,
          error: "Chrome process acquisition owner does not match the persisted launch generation",
        };
      }
      let exactOwner: boolean;
      try {
        exactOwner = await (deps.verifyChromeProcessIdentity ?? verifyChromeProcessIdentity)(
          profileDir,
          processIdentity,
        );
      } catch (error) {
        return {
          status: "pending",
          resource,
          error: `Chrome process acquisition exact owner verification failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const withOwner = (keepBrowser: boolean): BrowserRecoveryCleanupResourceMetadata =>
        completeAcquisition({
          ...resource,
          chromePid: processIdentity.pid,
          chromeProcessIdentity: processIdentity,
          chromePort: recordedOwner.port,
          profileDirectoryIdentity: processIdentity.profileDirectory,
          recoveryCleanup: {
            ...resource.recoveryCleanup,
            profileKind:
              provenance === "manual-canonical-owner"
                ? "manual-login"
                : resource.recoveryCleanup.profileKind,
            keepBrowser,
          },
        });
      if (!exactOwner) {
        let termination: RecordedChromeTerminationOutcome;
        try {
          termination = await (
            deps.terminateRecordedChromeForProfile ?? terminateRecordedChromeForProfile
          )(profileDir, processIdentity, logger);
        } catch (error) {
          return {
            status: "pending",
            resource,
            error: `Chrome process acquisition absence check failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        if (isSafeChromeTerminationOutcome(termination)) {
          return { status: "resolved", resource: withOwner(false) };
        }
        return {
          status: "pending",
          resource,
          error: `Chrome process acquisition exact authority is unresolved: ${termination.reason}`,
        };
      }

      return {
        status: "resolved",
        resource: withOwner(
          provenance === "manual-canonical-owner"
            ? recordedOwner.disposition === "preserve"
            : disposition === "preserve",
        ),
      };
    }

    let discovery: ChromeLaunchClaimProcessDiscovery;
    try {
      discovery = await (
        deps.inspectRunningChromeProcessesForLaunchClaim ??
        inspectRunningChromeProcessesForLaunchClaim
      )(profileDir, launchClaim);
    } catch (error) {
      return {
        status: "pending",
        resource,
        error: `Chrome process acquisition launch claim discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (discovery.conflictingProfilePids.length > 0) {
      return {
        status: "pending",
        resource,
        error: `Chrome process acquisition profile is used by an unauthenticated process generation: ${discovery.conflictingProfilePids.join(", ")}`,
      };
    }
    if (discovery.exactMatches.length > 1) {
      return {
        status: "pending",
        resource,
        error: "Chrome process acquisition launch claim matches multiple process generations",
      };
    }
    const launchedProcess = discovery.exactMatches[0];
    if (!launchedProcess) {
      return {
        status: "resolved",
        resource: completeAcquisition({
          ...resource,
          chromePid: undefined,
          chromeProcessIdentity: undefined,
          chromePort: undefined,
          chromeBrowserWSEndpoint: undefined,
          recoveryCleanup: {
            ...resource.recoveryCleanup,
            profileKind:
              provenance === "manual-canonical-owner"
                ? "manual-login"
                : resource.recoveryCleanup.profileKind,
            keepBrowser: provenance === "manual-canonical-owner",
          },
        }),
      };
    }
    if (!launchedProcess.port) {
      return {
        status: "pending",
        resource,
        error: "Chrome process acquisition exact launch is still waiting for a DevTools endpoint",
      };
    }

    let processIdentity: ChromeProcessIdentity;
    try {
      processIdentity = await (deps.captureChromeProcessIdentity ?? captureChromeProcessIdentity)(
        profileDir,
        launchedProcess.pid,
        launchClaim,
      );
    } catch (error) {
      return {
        status: "pending",
        resource,
        error: `Chrome process acquisition exact launch capture failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!sameProfileDirectoryIdentity(processIdentity.profileDirectory, expectedProfile)) {
      return {
        status: "pending",
        resource,
        error: "Chrome process acquisition exact launch profile changed during capture",
      };
    }

    let endpointAuthority: RetainedChromeEndpointAuthority;
    try {
      endpointAuthority = await (
        deps.retainChromeEndpointAuthority ?? retainChromeEndpointAuthority
      )({
        host: resource.chromeHost ?? "127.0.0.1",
        port: launchedProcess.port,
        userDataDir: profileDir,
        processIdentity,
      });
    } catch (error) {
      return {
        status: "pending",
        resource,
        error: `Chrome process acquisition endpoint authentication failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const promotedOwner: OracleChromeOwnerRecord = {
      port: launchedProcess.port,
      processIdentity,
      disposition,
    };
    try {
      if (
        !(await (deps.verifyChromeProcessIdentity ?? verifyChromeProcessIdentity)(
          profileDir,
          processIdentity,
        ))
      ) {
        throw new Error("recovered owner process generation changed before publication");
      }
      await (deps.writeOracleChromeOwner ?? writeOracleChromeOwner)(profileDir, promotedOwner);
      if (
        !(await (deps.verifyChromeProcessIdentity ?? verifyChromeProcessIdentity)(
          profileDir,
          processIdentity,
        ))
      ) {
        throw new Error("promoted owner process generation could not be reverified");
      }
    } catch (error) {
      await endpointAuthority.release().catch((releaseError: unknown) => {
        logger(
          `Failed to release Chrome endpoint authority after owner promotion failure: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
        );
      });
      return {
        status: "pending",
        resource,
        error: `Chrome process acquisition owner promotion failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return settleAcquisitionEndpointRelease(
      {
        ...resource,
        chromePid: processIdentity.pid,
        chromeProcessIdentity: processIdentity,
        chromePort: promotedOwner.port,
        chromeBrowserWSEndpoint: endpointAuthority.browserWSEndpoint,
        profileDirectoryIdentity: processIdentity.profileDirectory,
        recoveryCleanup: {
          ...resource.recoveryCleanup,
          profileKind:
            provenance === "manual-canonical-owner"
              ? "manual-login"
              : resource.recoveryCleanup.profileKind,
          keepBrowser: disposition === "preserve",
        },
      },
      endpointAuthority,
    );
  } finally {
    await promotionLock.release().catch((error: unknown) => {
      logger(
        `Failed to release Chrome owner promotion lock: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}

export async function reconcilePendingProcessAcquisitions(
  runtime: BrowserRuntimeMetadata,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps,
): Promise<ProcessAcquisitionReconciliationResult> {
  const resources: BrowserRecoveryCleanupResourceMetadata[] = [];
  const pending: RecoveryCleanupEntry[] = [];
  const errors: string[] = [];
  for (const [order, resource] of (runtime.recoveryCleanupResources ?? []).entries()) {
    const resolution = await reconcilePendingProcessAcquisition(resource, logger, deps);
    if (resolution.status === "settled") continue;
    if (resolution.status === "pending") {
      pending.push({ resource: resolution.resource, order });
      errors.push(resolution.error);
      continue;
    }
    resources.push(resolution.resource);
  }
  return { runtime: { ...runtime, recoveryCleanupResources: resources }, pending, errors };
}
