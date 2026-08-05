import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import type { BrowserRecoveryCleanupResourceMetadata } from "../sessionManager.js";
import { loadUserConfig } from "../config.js";
import { settleRemoteBrowserRecovery } from "../remote/client.js";
import { resolveRemoteServiceConfig } from "../remote/remoteServiceConfig.js";
import type { BrowserCaptureFinalizationResult, BrowserLogger } from "./types.js";
import {
  closeChromeTarget,
  closeChromeTargetWithExactAuthority,
  listChromeTargetsWithExactAuthority,
  listRemoteChromeTargets,
  retainChromeEndpointAuthority,
  type RemoteTargetInfo,
  type RetainedChromeEndpointAuthority,
} from "./chromeLifecycle.js";
import {
  captureChromeProcessIdentity,
  cleanupStaleProfileState,
  inspectRunningChromeProcessesForLaunchClaim,
  inspectChromeProcessIdentity,
  isSafeChromeTerminationOutcome,
  parseChromeProcessLaunchClaim,
  readOracleChromeOwner,
  removeProfileDirectoryIfIdentityMatches,
  sameChromeProcessIdentity,
  sameChromeProcessLaunchClaim,
  sameProfileDirectoryIdentity,
  terminateRecordedChromeForProfile,
  verifyChromeProcessIdentity,
  verifyProfileDirectoryIdentity,
  writeOracleChromeOwner,
  type ChromeLaunchClaimProcessDiscovery,
  type ChromeProcessIdentity,
  type OracleChromeOwnerRecord,
  type ProfileDirectoryIdentity,
  type RecordedChromeTerminationOutcome,
} from "./profileState.js";
import {
  releaseBrowserTabLease,
  teardownBrowserResourcesIfNoActiveLeases,
} from "./tabLeaseRegistry.js";
import { inferPortFromBrowserWSEndpoint } from "./reattachRuntime.js";
import {
  projectBrowserCaptureCleanupRuntime,
  projectBrowserCaptureFinalization,
} from "./runLifecycle.js";

export interface ReattachCleanupDeps {
  closeChromeTarget?: typeof closeChromeTarget;
  closeChromeTargetWithExactAuthority?: typeof closeChromeTargetWithExactAuthority;
  listChromeTargets?: typeof listRemoteChromeTargets;
  listChromeTargetsWithExactAuthority?: typeof listChromeTargetsWithExactAuthority;
  retainChromeEndpointAuthority?: typeof retainChromeEndpointAuthority;
  captureChromeProcessIdentity?: typeof captureChromeProcessIdentity;
  inspectRunningChromeProcessesForLaunchClaim?: typeof inspectRunningChromeProcessesForLaunchClaim;
  inspectChromeProcessIdentity?: typeof inspectChromeProcessIdentity;
  verifyProfileDirectoryIdentity?: typeof verifyProfileDirectoryIdentity;
  terminateRecordedChromeForProfile?: typeof terminateRecordedChromeForProfile;
  terminateExactChromeForProfile?: typeof terminateRecordedChromeForProfile;
  readOracleChromeOwner?: typeof readOracleChromeOwner;
  verifyChromeProcessIdentity?: typeof verifyChromeProcessIdentity;
  writeOracleChromeOwner?: typeof writeOracleChromeOwner;
  cleanupStaleProfileState?: typeof cleanupStaleProfileState;
  teardownBrowserResourcesIfNoActiveLeases?: typeof teardownBrowserResourcesIfNoActiveLeases;
  removeProfile?: (profileDir: string) => Promise<boolean>;
  releaseBrowserTabLease?: typeof releaseBrowserTabLease;
  settleRemoteBrowserRecovery?: typeof settleRemoteBrowserRecovery;
  resolveRemoteRecoveryConfig?: () => Promise<{ host?: string; token?: string }>;
  isRemotePublicationAcknowledged?: () => boolean;
}

export type ReattachFinalizationResult = BrowserCaptureFinalizationResult;
type RecoveryCleanupEntry = {
  resource: BrowserRecoveryCleanupResourceMetadata;
  order: number;
};

type RecoveryCleanupGroup = {
  key: string;
  entries: RecoveryCleanupEntry[];
};
type PendingProcessAcquisitionResolution =
  | { status: "resolved"; resource: BrowserRecoveryCleanupResourceMetadata }
  | { status: "settled" }
  | { status: "pending"; resource: BrowserRecoveryCleanupResourceMetadata; error: string };
type PersistedLocalEndpointBinding =
  | { status: "gone" }
  | {
      status: "bound";
      host: string;
      port: number;
      browserWSEndpoint: string;
      authority: RetainedChromeEndpointAuthority;
    };

async function bindPersistedLocalEndpoint(
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

function requiresExactLocalTargetBinding(
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
  if (acquisition?.pendingResource !== "chrome-process" || resource.chromeProcessIdentity) {
    return { status: "resolved", resource };
  }
  const completeAcquisition = (
    next: BrowserRecoveryCleanupResourceMetadata,
  ): BrowserRecoveryCleanupResourceMetadata => ({
    ...next,
    acquisition: { ...acquisition, pendingResource: undefined },
  });

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
    endpointAuthority = await (deps.retainChromeEndpointAuthority ?? retainChromeEndpointAuthority)(
      {
        host: resource.chromeHost ?? "127.0.0.1",
        port: launchedProcess.port,
        userDataDir: profileDir,
        processIdentity,
      },
    );
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
  await endpointAuthority.release().catch((error: unknown) => {
    logger(
      `Failed to release recovered Chrome endpoint authority after durable owner promotion: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return {
    status: "resolved",
    resource: completeAcquisition({
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
    }),
  };
}

async function reconcilePendingProcessAcquisitions(
  runtime: BrowserRuntimeMetadata,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps,
): Promise<{ runtime: BrowserRuntimeMetadata; pending: RecoveryCleanupEntry[]; errors: string[] }> {
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

export async function finalizeRecoveredRuntime(
  runtime: BrowserRuntimeMetadata,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps = {},
  mode: "finalize" | "abort" = "finalize",
): Promise<ReattachFinalizationResult> {
  if (
    mode === "finalize" &&
    !runtime.recoveryCleanupResult?.settlementMode &&
    runtime.recoveryCleanupResources?.some((resource) => resource.remoteRecovery) &&
    deps.isRemotePublicationAcknowledged?.() !== true
  ) {
    return pendingFinalization(
      runtime,
      "Remote settlement requires durable answer publication acknowledgment.",
    );
  }

  const reconciliation = await reconcilePendingProcessAcquisitions(runtime, logger, deps);
  const groups = groupRecoveryCleanupResources(reconciliation.runtime);
  const pending: RecoveryCleanupEntry[] = [...reconciliation.pending];
  const errors: string[] = [...reconciliation.errors];

  for (const group of groups) {
    const result = await finalizeRecoveryCleanupGroup(group, logger, deps, mode);
    pending.push(...result.pending);
    errors.push(...result.errors);
  }

  if (pending.length === 0) {
    const completedRuntime = { ...reconciliation.runtime };
    delete completedRuntime.recoveryCleanupResources;
    delete completedRuntime.recoveryCleanupResult;
    return projectBrowserCaptureFinalization(
      runtime,
      { status: "completed", runtime: completedRuntime },
      mode,
    );
  }

  const error = [...new Set(errors)].join("; ") || "Browser recovery cleanup remains pending";
  const pendingRuntime = rebuildPendingCleanupRuntime(runtime, pending, error, mode);
  return projectBrowserCaptureFinalization(
    runtime,
    { status: "pending", runtime: pendingRuntime, error },
    mode,
  );
}

async function finalizeRecoveryCleanupGroup(
  group: RecoveryCleanupGroup,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps,
  mode: "finalize" | "abort",
): Promise<{ pending: RecoveryCleanupEntry[]; errors: string[] }> {
  if (group.entries[0]?.resource.remoteRecovery) {
    return finalizeRemoteRecoveryCleanupGroup(group, deps, mode);
  }
  const pending: RecoveryCleanupEntry[] = [];
  const errors: string[] = [];
  const pendingKeys = new Set<string>();
  const releasedLeaseIds = new Set<string>();
  const groupLabel = createHash("sha256").update(group.key).digest("hex").slice(0, 12);
  const addPending = (entry: RecoveryCleanupEntry, error: string): void => {
    const key = recoveryCleanupResourceKey(entry.resource);
    if (!pendingKeys.has(key)) {
      pendingKeys.add(key);
      pending.push(entry);
    }
    errors.push(`Cleanup group ${groupLabel}: ${error}`);
  };

  let endpointAuthority: RetainedChromeEndpointAuthority | undefined;
  let endpointPendingEntry: RecoveryCleanupEntry | undefined;
  try {
    const teardownEntries = group.entries.filter((entry) =>
      requestsProcessTeardown(entry.resource),
    );
    const preserveProcess = group.entries.some(
      (entry) => entry.resource.recoveryCleanup.keepBrowser,
    );
    const teardownRepresentative =
      teardownEntries.find((entry) => entry.resource.userDataDir) ?? teardownEntries[0];
    const teardownEntry = teardownRepresentative
      ? teardownOnlyEntry(teardownRepresentative)
      : undefined;
    if (teardownEntries.length > 0 && !preserveProcess) {
      const invariantError = await validateGroupTeardownInvariants(teardownEntries);
      if (invariantError && teardownEntry) {
        addPending(teardownEntry, invariantError);
        return { pending, errors };
      }
    }

    const targets = new Map<string, RecoveryCleanupEntry[]>();
    for (const entry of group.entries) {
      const { resource } = entry;
      const cleanup = resource.recoveryCleanup;
      if (!cleanup.ownsTarget) continue;
      if (mode === "finalize") {
        if (typeof cleanup.closeOwnedTargetOnComplete !== "boolean") {
          addPending(entry, "Owned Chrome target finalize disposition is missing");
          continue;
        }
        if (!cleanup.closeOwnedTargetOnComplete) continue;
      }
      const targetKey =
        resource.chromeTargetId ?? `missing:${recoveryCleanupResourceKey(resource)}`;
      const targetEntries = targets.get(targetKey);
      if (targetEntries) targetEntries.push(entry);
      else targets.set(targetKey, [entry]);
    }

    let connectionEntry: RecoveryCleanupEntry | undefined;
    for (let index = group.entries.length - 1; index >= 0; index -= 1) {
      const candidate = group.entries[index];
      if (
        candidate &&
        Boolean(
          candidate.resource.chromePort ??
          inferPortFromBrowserWSEndpoint(candidate.resource.chromeBrowserWSEndpoint),
        )
      ) {
        connectionEntry = candidate;
        break;
      }
    }
    connectionEntry ??= teardownRepresentative ?? group.entries[group.entries.length - 1];
    const connectionResource = connectionEntry?.resource;
    endpointPendingEntry = connectionEntry ?? teardownEntry;
    let connectionPort = connectionResource
      ? (connectionResource.chromePort ??
        inferPortFromBrowserWSEndpoint(connectionResource.chromeBrowserWSEndpoint))
      : undefined;
    let connectionHost = connectionResource?.chromeHost ?? "127.0.0.1";
    let connectionEndpoint = connectionResource?.chromeBrowserWSEndpoint;
    let recordedProcessExited = false;

    const exactTargetBindingRequired =
      targets.size > 0 &&
      (!connectionResource || requiresExactLocalTargetBinding(connectionResource));
    const exactTeardownBindingRequired =
      teardownEntries.length > 0 &&
      !preserveProcess &&
      Boolean(teardownEntry?.resource.chromeProcessIdentity) &&
      !deps.terminateExactChromeForProfile;

    if (exactTargetBindingRequired || exactTeardownBindingRequired) {
      if (!connectionResource) {
        const message = "Local Chrome cleanup endpoint metadata is missing";
        for (const targetEntries of targets.values()) {
          for (const entry of targetEntries) addPending(entry, message);
        }
        if (teardownEntry) addPending(teardownEntry, message);
        return { pending, errors };
      }
      try {
        const binding = await bindPersistedLocalEndpoint(connectionResource, deps);
        if (binding.status === "gone") {
          recordedProcessExited = true;
        } else {
          endpointAuthority = binding.authority;
          connectionHost = binding.host;
          connectionPort = binding.port;
          connectionEndpoint = binding.browserWSEndpoint;
        }
      } catch (error) {
        const message = `Exact Chrome endpoint authentication failed: ${error instanceof Error ? error.message : String(error)}`;
        if (exactTargetBindingRequired) {
          for (const targetEntries of targets.values()) {
            for (const entry of targetEntries) addPending(entry, message);
          }
        }
        if (exactTeardownBindingRequired && teardownEntry) addPending(teardownEntry, message);
        return { pending, errors };
      }
    }

    if (!recordedProcessExited) {
      let discoveredTargets: RemoteTargetInfo[] | null = null;
      let exactTargetFailure: string | null = null;
      targetCleanup: for (const targetEntries of targets.values()) {
        const representative = targetEntries[0];
        if (!representative) continue;
        const resource = representative.resource;
        let targetId = resource.chromeTargetId;
        const targetMarkerUrl = resource.acquisition?.targetMarkerUrl;
        if (!targetId && targetMarkerUrl && connectionResource && connectionPort) {
          try {
            if (endpointAuthority) {
              const listed = await (
                deps.listChromeTargetsWithExactAuthority ?? listChromeTargetsWithExactAuthority
              )(endpointAuthority);
              if (listed.status === "gone") {
                recordedProcessExited = true;
                break targetCleanup;
              }
              if (listed.status === "unsafe") {
                exactTargetFailure = listed.reason;
                break targetCleanup;
              }
              discoveredTargets ??= listed.value;
            } else {
              discoveredTargets ??= await (deps.listChromeTargets ?? listRemoteChromeTargets)({
                host: connectionHost,
                port: connectionPort,
                browserWSEndpoint: connectionEndpoint,
              });
            }
            const matches = discoveredTargets.filter(
              (target) =>
                target.type === "page" && target.url === targetMarkerUrl && target.targetId,
            );
            if (matches.length === 0) continue;
            if (matches.length === 1) targetId = matches[0]?.targetId;
            else {
              for (const entry of targetEntries) {
                addPending(
                  entry,
                  `Owned Chrome target acquisition marker is ambiguous: ${targetMarkerUrl}`,
                );
              }
              continue;
            }
          } catch (error) {
            for (const entry of targetEntries) {
              addPending(
                entry,
                `Chrome target acquisition recovery failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            continue;
          }
        }
        if (!targetId || !connectionResource || !connectionPort) {
          for (const entry of targetEntries) {
            addPending(entry, "Owned Chrome target cleanup metadata is incomplete");
          }
          continue;
        }
        try {
          if (endpointAuthority) {
            const closed = await (
              deps.closeChromeTargetWithExactAuthority ?? closeChromeTargetWithExactAuthority
            )({ authority: endpointAuthority, targetId, logger });
            if (closed.status === "gone") {
              recordedProcessExited = true;
              break targetCleanup;
            }
            if (closed.status === "unsafe") {
              exactTargetFailure = closed.reason;
              break targetCleanup;
            }
          } else {
            const closed = await (deps.closeChromeTarget ?? closeChromeTarget)({
              host: connectionHost,
              port: connectionPort,
              browserWSEndpoint: connectionEndpoint,
              targetId,
              logger,
            });
            if (!closed) {
              for (const entry of targetEntries) {
                addPending(entry, `Chrome target close was not confirmed: ${targetId}`);
              }
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          for (const entry of targetEntries) {
            addPending(entry, `Chrome target close failed: ${message}`);
          }
        }
      }
      if (exactTargetFailure) {
        for (const targetEntries of targets.values()) {
          for (const entry of targetEntries) {
            addPending(entry, `Exact Chrome target cleanup was unsafe: ${exactTargetFailure}`);
          }
        }
      }
    }

    if (
      pending.length > 0 &&
      teardownEntry &&
      teardownEntries.length > 0 &&
      !preserveProcess &&
      !pending.some((entry) => requestsProcessTeardown(entry.resource))
    ) {
      addPending(teardownEntry, "Process teardown deferred until target cleanup completes");
      return { pending, errors };
    }
    if (pending.length > 0) return { pending, errors };

    let teardownViaLeaseAttempted = false;
    let teardownViaLeaseError: string | null = null;
    let manualOwnerRetainedByOtherLease = false;
    const releaseLease = deps.releaseBrowserTabLease ?? releaseBrowserTabLease;
    const seenLeaseIds = new Set<string>();
    for (const entry of group.entries) {
      const lease = entry.resource.tabLease;
      if (!lease || seenLeaseIds.has(lease.id)) continue;
      seenLeaseIds.add(lease.id);
      const profileDir = entry.resource.userDataDir;
      if (!profileDir) {
        addPending(teardownOnlyEntry(entry), "Browser tab lease profile path is missing");
        continue;
      }
      try {
        await releaseLease(profileDir, lease.id, logger, {
          expectedProfileIdentity: lease.profileDirectory,
          onRelease:
            teardownEntry &&
            teardownEntries.length > 0 &&
            !preserveProcess &&
            teardownEntry.resource.recoveryCleanup.profileKind === "manual-login"
              ? async ({ isLastLease }) => {
                  if (!isLastLease) {
                    manualOwnerRetainedByOtherLease = true;
                    return;
                  }
                  teardownViaLeaseAttempted = true;
                  try {
                    teardownViaLeaseError = await teardownLocalRecoveryGroup(
                      teardownEntry.resource,
                      logger,
                      deps,
                      { endpointAuthority, recordedProcessExited },
                    );
                  } catch (error) {
                    teardownViaLeaseError = error instanceof Error ? error.message : String(error);
                  }
                }
              : undefined,
        });
        releasedLeaseIds.add(lease.id);
      } catch (error) {
        addPending(
          teardownOnlyEntry(entry),
          `Browser tab lease release failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (pending.length > 0) {
      if (
        teardownEntry &&
        teardownEntries.length > 0 &&
        !preserveProcess &&
        !pending.some((entry) => requestsProcessTeardown(entry.resource))
      ) {
        addPending(
          removeReleasedLeaseAuthority(teardownEntry, releasedLeaseIds),
          "Process teardown deferred until lease cleanup completes",
        );
      }
      return { pending, errors };
    }
    if (manualOwnerRetainedByOtherLease) return { pending, errors };
    if (!teardownEntry || teardownEntries.length === 0 || preserveProcess) {
      return { pending, errors };
    }

    const resource = removeReleasedLeaseAuthority(teardownEntry, releasedLeaseIds).resource;
    const profileKind = resource.recoveryCleanup.profileKind;
    try {
      let teardownError: string | null = null;
      const authority = { endpointAuthority, recordedProcessExited };
      if (profileKind === "manual-login") {
        teardownError = teardownViaLeaseAttempted
          ? teardownViaLeaseError
          : await teardownManualLoginRecoveryGroupIfNoActiveLeases(
              resource,
              logger,
              deps,
              authority,
            );
      } else {
        teardownError = await teardownLocalRecoveryGroup(resource, logger, deps, authority);
      }

      if (teardownError) {
        addPending(removeReleasedLeaseAuthority(teardownEntry, releasedLeaseIds), teardownError);
      }
    } catch (error) {
      addPending(
        removeReleasedLeaseAuthority(teardownEntry, releasedLeaseIds),
        error instanceof Error ? error.message : String(error),
      );
    }
    return { pending, errors };
  } catch (error) {
    const first = group.entries[0];
    if (first) addPending(first, error instanceof Error ? error.message : String(error));
    return { pending, errors };
  } finally {
    if (endpointAuthority) {
      try {
        await endpointAuthority.release();
      } catch (error) {
        const entry = endpointPendingEntry ?? group.entries[0];
        if (entry) {
          addPending(
            removeReleasedLeaseAuthority(entry, releasedLeaseIds),
            `Exact Chrome endpoint release failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
}

async function finalizeRemoteRecoveryCleanupGroup(
  group: RecoveryCleanupGroup,
  deps: ReattachCleanupDeps,
  mode: "finalize" | "abort",
): Promise<{ pending: RecoveryCleanupEntry[]; errors: string[] }> {
  const representative = group.entries[group.entries.length - 1];
  if (!representative) return { pending: [], errors: [] };
  const authority = representative.resource.remoteRecovery;
  const groupLabel = createHash("sha256").update(group.key).digest("hex").slice(0, 12);
  const pending = (error: string, remoteRecovery = authority) => ({
    pending: group.entries.map((entry) => ({
      ...entry,
      resource: {
        ...entry.resource,
        remoteRecovery,
      },
    })),
    errors: [`Cleanup group ${groupLabel}: ${error}`],
  });
  if (!authority) {
    return pending("Remote cleanup transaction authority is missing.");
  }
  if (mode === "finalize" && deps.isRemotePublicationAcknowledged?.() !== true) {
    return pending("Remote settlement requires durable answer publication acknowledgment.");
  }

  let configured: { host?: string; token?: string };
  try {
    if (deps.resolveRemoteRecoveryConfig) {
      configured = await deps.resolveRemoteRecoveryConfig();
    } else {
      const { config: userConfig } = await loadUserConfig({ includeProject: false });
      configured = resolveRemoteServiceConfig({ userConfig, env: process.env });
    }
  } catch (error) {
    return pending(
      `Remote cleanup configuration is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const resource = representative.resource;
  const remoteResources = group.entries.map((entry) => ({
    ...entry.resource,
    remoteRecovery: authority,
  }));
  const runtime: BrowserRuntimeMetadata = {
    chromePid: resource.chromePid,
    chromeProcessIdentity: resource.chromeProcessIdentity,
    chromePort: resource.chromePort,
    chromeHost: resource.chromeHost,
    chromeBrowserWSEndpoint: resource.chromeBrowserWSEndpoint,
    chromeProfileRoot: resource.chromeProfileRoot,
    userDataDir: resource.userDataDir,
    chromeTargetId: resource.chromeTargetId,
    conversationId: resource.conversationId,
    promptEpoch: resource.promptEpoch,
    recoveryCleanupResources: remoteResources,
    recoveryCleanupResult: { status: "pending", settlementMode: mode },
  };
  let result: BrowserCaptureFinalizationResult;
  try {
    result = await (deps.settleRemoteBrowserRecovery ?? settleRemoteBrowserRecovery)({
      runtime,
      configuredHost: configured.host ?? "",
      authToken: configured.token,
      mode,
    });
  } catch (error) {
    return pending(
      `Remote cleanup settlement remains retryable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.status === "completed") return { pending: [], errors: [] };
  const returnedAuthority = result.runtime.recoveryCleanupResources?.find(
    (candidate) => candidate.remoteRecovery,
  )?.remoteRecovery;
  return pending(
    result.error || "Remote cleanup settlement remains pending.",
    returnedAuthority ?? authority,
  );
}

type LocalRecoveryTeardownAuthority = {
  endpointAuthority?: RetainedChromeEndpointAuthority;
  recordedProcessExited: boolean;
};

async function teardownManualLoginRecoveryGroupIfNoActiveLeases(
  resource: BrowserRecoveryCleanupResourceMetadata,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps,
  authority: LocalRecoveryTeardownAuthority,
): Promise<string | null> {
  const teardown =
    deps.teardownBrowserResourcesIfNoActiveLeases ?? teardownBrowserResourcesIfNoActiveLeases;
  const profileDir = resource.userDataDir;
  const processIdentity = resource.chromeProcessIdentity;
  const profileDirectory = physicalProfileDirectoryIdentity(processIdentity?.profileDirectory);
  if (!profileDir) return "Cleanup profile path is missing";
  if (!processIdentity) return "Chrome process identity cleanup metadata is missing";
  if (!profileDirectory) return "Chrome physical profile identity cleanup metadata is missing";

  let directError: string | null = null;
  const outcome = await teardown(
    profileDir,
    async () => {
      directError = await teardownLocalRecoveryGroup(resource, logger, deps, authority);
      return directError === null;
    },
    { logger, expectedProfileIdentity: profileDirectory },
  );
  return outcome.status === "completed"
    ? null
    : (directError ??
        outcome.error ??
        `Manual-login cleanup preserved resources (${outcome.reason})`);
}

async function teardownLocalRecoveryGroup(
  resource: BrowserRecoveryCleanupResourceMetadata,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps,
  authority: LocalRecoveryTeardownAuthority,
): Promise<string | null> {
  const profileKind = resource.recoveryCleanup.profileKind;
  const profileDir = resource.userDataDir;
  const profileError = validateCleanupProfilePath(resource, profileKind);
  if (!profileDir || profileError) return profileError ?? "Cleanup profile path is missing";

  const processIdentity = resource.chromeProcessIdentity;
  if (
    !processIdentity &&
    (profileKind === "temporary" || profileKind === "copied") &&
    (await cleanupProfileAbsent(profileDir))
  ) {
    return null;
  }
  const profileDirectory = physicalProfileDirectoryIdentity(
    processIdentity?.profileDirectory ?? resource.profileDirectoryIdentity,
  );
  if (!profileDirectory) {
    return "Chrome physical profile identity cleanup metadata is missing";
  }
  if (
    !(await (deps.verifyProfileDirectoryIdentity ?? verifyProfileDirectoryIdentity)(
      profileDir,
      profileDirectory,
    ))
  ) {
    return "Chrome process identity does not match the cleanup profile";
  }

  if (processIdentity && !authority.recordedProcessExited) {
    const exactTerminator = deps.terminateExactChromeForProfile;
    const termination = authority.endpointAuthority
      ? await authority.endpointAuthority.kill()
      : exactTerminator
        ? await exactTerminator(profileDir, processIdentity, logger)
        : null;
    if (!termination) {
      return "Exact Chrome endpoint authority is unavailable for process teardown";
    }
    if (!isSafeChromeTerminationOutcome(termination)) {
      if (profileKind === "manual-login") {
        logger(`[browser] Preserving manual-login profile: ${termination.reason}`);
      }
      return termination.reason;
    }
    if (termination.pid !== undefined && termination.pid !== processIdentity.pid) {
      return "Exact Chrome endpoint authority stopped a different process generation";
    }
  } else if (!processIdentity && profileKind === "manual-login") {
    return "Chrome process identity cleanup metadata is missing";
  }

  if (profileKind === "manual-login") {
    const cleanupProfileState = deps.cleanupStaleProfileState ?? cleanupStaleProfileState;
    return (await cleanupProfileState(profileDir, logger, {
      lockRemovalMode: "never",
      expectedProfileIdentity: profileDirectory,
    }))
      ? null
      : `Manual-login profile cleanup was not confirmed: ${profileDir}`;
  }

  return (await removeCleanupProfile(profileDir, profileDirectory, deps.removeProfile))
    ? null
    : `Profile removal was not confirmed: ${profileDir}`;
}
function groupRecoveryCleanupResources(runtime: BrowserRuntimeMetadata): RecoveryCleanupGroup[] {
  const entries: RecoveryCleanupEntry[] = (runtime.recoveryCleanupResources ?? []).map(
    (resource, order) => ({ resource, order }),
  );
  const unique = new Map<string, RecoveryCleanupEntry>();
  for (const entry of entries) {
    const key = recoveryCleanupResourceKey(entry.resource);
    if (!unique.has(key)) unique.set(key, entry);
  }

  const groups = new Map<string, RecoveryCleanupGroup>();
  for (const entry of unique.values()) {
    const key = recoveryCleanupGroupKey(entry.resource);
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { key, entries: [entry] });
  }
  return [...groups.values()];
}

export function recoveryCleanupGroupKey(resource: BrowserRecoveryCleanupResourceMetadata): string {
  if (!resource.remoteRecovery) {
    const processIdentity = resource.chromeProcessIdentity;
    const profileIdentity = profileDirectoryIdentityKey(
      processIdentity?.profileDirectory ?? resource.profileDirectoryIdentity,
    ) ?? ["missing-physical-profile", resource.chromeProfileRoot ?? resource.userDataDir ?? null];
    return JSON.stringify(["local", chromeProcessIdentityKey(processIdentity), profileIdentity]);
  }
  const remoteIdentity = remoteRecoveryIdentityKey(resource.remoteRecovery);
  return JSON.stringify(
    remoteIdentity
      ? ["remote", remoteIdentity]
      : [
          "remote-missing-authority",
          immutablePromptIdentity(resource.promptEpoch),
          resource.conversationId ?? null,
          resource.chromeProfileRoot ?? resource.userDataDir ?? null,
        ],
  );
}

function recoveryCleanupResourceKey(resource: BrowserRecoveryCleanupResourceMetadata): string {
  return JSON.stringify([
    recoveryCleanupGroupKey(resource),
    resource.chromeTargetId ?? null,
    resource.chromeHost ?? null,
    resource.chromePort ?? null,
    resource.chromeBrowserWSEndpoint ?? null,
    resource.chromeProcessIdentity?.launchNonce ?? null,
    profileDirectoryIdentityKey(resource.profileDirectoryIdentity) ?? null,
    resource.acquisition?.generationId ?? null,
    resource.acquisition?.pendingResource ?? null,
    [
      resource.acquisition?.processLaunchClaim?.version ?? null,
      resource.acquisition?.processLaunchClaim?.generationId ?? null,
      resource.acquisition?.processLaunchClaim?.nonce ?? null,
    ],
    resource.acquisition?.processOwnerDisposition ?? null,
    resource.acquisition?.targetMarkerUrl ?? null,
    Boolean(resource.remoteRecovery),
    resource.recoveryCleanup.ownsTarget,
    resource.recoveryCleanup.profileKind,
    resource.recoveryCleanup.keepBrowser,
    resource.recoveryCleanup.closeOwnedTargetOnComplete ?? null,
  ]);
}

export function chromeProcessIdentityKey(
  identity: BrowserRecoveryCleanupResourceMetadata["chromeProcessIdentity"],
): readonly unknown[] | null {
  if (!identity) return null;
  return [
    identity.pid,
    identity.processStartTime,
    identity.executablePath,
    identity.normalizedUserDataDir,
    identity.launchNonce,
    [
      identity.launchClaim?.version ?? null,
      identity.launchClaim?.generationId ?? null,
      identity.launchClaim?.nonce ?? null,
    ],
    profileDirectoryIdentityKey(identity.profileDirectory) ?? ["missing-physical-profile"],
  ];
}

function physicalProfileDirectoryIdentity(identity: unknown): ProfileDirectoryIdentity | null {
  if (!identity || typeof identity !== "object") return null;
  const candidate = identity as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.platform !== "string" ||
    typeof candidate.canonicalPath !== "string" ||
    typeof candidate.device !== "string" ||
    typeof candidate.inode !== "string"
  ) {
    return null;
  }
  return identity as ProfileDirectoryIdentity;
}

function profileDirectoryIdentityKey(identity: unknown): readonly unknown[] | null {
  const physicalProfile = physicalProfileDirectoryIdentity(identity);
  if (!physicalProfile) return null;
  return [
    physicalProfile.version,
    physicalProfile.platform,
    physicalProfile.canonicalPath,
    physicalProfile.device,
    physicalProfile.inode,
  ];
}

export function immutablePromptIdentity(
  promptEpoch: BrowserRecoveryCleanupResourceMetadata["promptEpoch"],
): readonly unknown[] | null {
  if (!promptEpoch) return null;
  return [
    promptEpoch.epochId,
    promptEpoch.promptSha256,
    promptEpoch.followUpOrdinal,
    promptEpoch.status === "committed" ? promptEpoch.conversationId : null,
  ];
}

function remoteRecoveryIdentityKey(
  authority: BrowserRecoveryCleanupResourceMetadata["remoteRecovery"],
): readonly unknown[] | null {
  return authority ? [authority.protocolVersion, authority.host, authority.transactionToken] : null;
}

function requestsProcessTeardown(resource: BrowserRecoveryCleanupResourceMetadata): boolean {
  const cleanup = resource.recoveryCleanup;
  return !resource.remoteRecovery && !cleanup.keepBrowser && cleanup.profileKind !== "none";
}

function teardownOnlyEntry(entry: RecoveryCleanupEntry): RecoveryCleanupEntry {
  return {
    order: entry.order,
    resource: {
      ...entry.resource,
      chromeTargetId: undefined,
      recoveryCleanup: {
        ...entry.resource.recoveryCleanup,
        ownsTarget: false,
        closeOwnedTargetOnComplete: undefined,
      },
    },
  };
}

function removeReleasedLeaseAuthority(
  entry: RecoveryCleanupEntry,
  releasedLeaseIds: Set<string>,
): RecoveryCleanupEntry {
  const leaseId = entry.resource.tabLease?.id;
  if (!leaseId || !releasedLeaseIds.has(leaseId)) return entry;
  return {
    ...entry,
    resource: { ...entry.resource, tabLease: undefined },
  };
}

async function validateGroupTeardownInvariants(
  entries: RecoveryCleanupEntry[],
): Promise<string | null> {
  const first = entries[0]?.resource;
  if (!first) return "Cleanup group has no teardown authority";
  const firstProcessIdentity = first.chromeProcessIdentity;
  const firstProfileDirectory = physicalProfileDirectoryIdentity(
    firstProcessIdentity?.profileDirectory ?? first.profileDirectoryIdentity,
  );
  const fallbackProfileSource = firstProcessIdentity
    ? null
    : (first.chromeProfileRoot ?? first.userDataDir);
  const fallbackProfile = fallbackProfileSource ? path.resolve(fallbackProfileSource) : null;
  for (const { resource } of entries) {
    if (recoveryCleanupGroupKey(resource) !== recoveryCleanupGroupKey(first)) {
      return "Cleanup group contains conflicting Chrome process identities";
    }
    if (resource.recoveryCleanup.profileKind !== first.recoveryCleanup.profileKind) {
      return "Cleanup group contains conflicting profile teardown metadata";
    }
    if (firstProfileDirectory) {
      if (
        resource.userDataDir &&
        !(await cleanupProfileAbsent(resource.userDataDir)) &&
        !(await verifyProfileDirectoryIdentity(resource.userDataDir, firstProfileDirectory))
      ) {
        return "Cleanup group user-data directory does not match its process identity";
      }
      if (
        resource.chromeProfileRoot &&
        !(await cleanupProfileAbsent(resource.chromeProfileRoot)) &&
        !(await verifyProfileDirectoryIdentity(resource.chromeProfileRoot, firstProfileDirectory))
      ) {
        return "Cleanup group profile root does not match its process identity";
      }
    } else {
      if (
        fallbackProfile &&
        resource.userDataDir &&
        path.resolve(resource.userDataDir) !== fallbackProfile
      ) {
        return "Cleanup group user-data directory does not match its process identity";
      }
      if (
        fallbackProfile &&
        resource.chromeProfileRoot &&
        path.resolve(resource.chromeProfileRoot) !== fallbackProfile
      ) {
        return "Cleanup group profile root does not match its process identity";
      }
    }
  }
  return null;
}

function rebuildPendingCleanupRuntime(
  runtime: BrowserRuntimeMetadata,
  entries: RecoveryCleanupEntry[],
  error: string,
  settlementMode: "finalize" | "abort",
): BrowserRuntimeMetadata {
  const ordered = [...entries].sort((left, right) => left.order - right.order);
  const resources: BrowserRecoveryCleanupResourceMetadata[] = [];
  const seen = new Set<string>();
  for (const entry of ordered) {
    const key = recoveryCleanupResourceKey(entry.resource);
    if (seen.has(key)) continue;
    seen.add(key);
    resources.push(entry.resource);
  }
  return projectBrowserCaptureCleanupRuntime(runtime, {
    ...runtime,
    recoveryCleanupResources: resources,
    recoveryCleanupResult: { status: "failed", error, settlementMode },
  });
}

async function cleanupProfileAbsent(profileDir: string): Promise<boolean> {
  try {
    await access(profileDir);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export function pendingFinalization(
  runtime: BrowserRuntimeMetadata,
  error: string,
  settlementMode?: "finalize" | "abort",
): ReattachFinalizationResult {
  const persistedMode = settlementMode ?? runtime.recoveryCleanupResult?.settlementMode;
  const resourceRuntime: BrowserRuntimeMetadata = {
    ...runtime,
    recoveryCleanupResult: {
      status: "failed",
      error,
      ...(persistedMode ? { settlementMode: persistedMode } : {}),
    },
  };
  return projectBrowserCaptureFinalization(
    runtime,
    { status: "pending", runtime: resourceRuntime, error },
    persistedMode,
  );
}

function validateCleanupProfilePath(
  runtime: BrowserRuntimeMetadata,
  profileKind: "temporary" | "manual-login" | "copied" | "none",
): string | null {
  const profileDir = runtime.userDataDir;
  if (!profileDir) return "Cleanup profile path is missing";
  if (!path.isAbsolute(profileDir) || path.resolve(profileDir) !== profileDir) {
    return `Cleanup profile path is not canonical and absolute: ${profileDir}`;
  }
  const root = path.parse(profileDir).root;
  if (profileDir === root || profileDir === path.resolve(os.homedir())) {
    return `Refusing unsafe cleanup profile path: ${profileDir}`;
  }
  if (
    runtime.chromeProfileRoot &&
    path.resolve(runtime.chromeProfileRoot) !== path.resolve(profileDir)
  ) {
    return "Serialized Chrome profile roots disagree";
  }
  if (profileKind !== "temporary" && profileKind !== "copied") return null;
  const basename = path.basename(profileDir);
  if (!basename.startsWith("oracle-browser-") && !basename.startsWith("oracle-reattach-")) {
    return `Refusing unrecognized temporary profile path: ${profileDir}`;
  }
  const allowedRoots = [
    os.tmpdir(),
    "/tmp",
    "/mnt/c/Users/Public/AppData/Local/Temp",
    "/mnt/c/Temp",
    "/mnt/c/Windows/Temp",
  ].map((candidate) => path.resolve(candidate));
  if (!allowedRoots.some((candidate) => isPathWithin(candidate, profileDir))) {
    return `Temporary profile is outside approved runtime roots: ${profileDir}`;
  }
  return null;
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function removeCleanupProfile(
  profileDir: string,
  expectedIdentity: ProfileDirectoryIdentity,
  removeProfile?: (profileDir: string) => Promise<boolean>,
): Promise<boolean> {
  if (removeProfile) {
    return (await removeProfile(profileDir)) === true;
  }
  return removeProfileDirectoryIfIdentityMatches(profileDir, expectedIdentity);
}
export function defaultRecoveryLockPath(runtime: BrowserRuntimeMetadata): string {
  const cleanupAuthority = (runtime.recoveryCleanupResources ?? []).map((resource) =>
    recoveryCleanupResourceKey(resource),
  );
  const identity = JSON.stringify([
    "recovery-v3",
    cleanupAuthority,
    immutablePromptIdentity(runtime.promptEpoch),
    runtime.conversationId ?? null,
  ]);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return path.join(os.tmpdir(), "oracle-browser-recovery-locks", `${digest}.lock`);
}
