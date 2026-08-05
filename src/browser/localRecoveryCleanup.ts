import { createHash } from "node:crypto";
import {
  closeChromeTarget,
  closeChromeTargetWithExactAuthority,
  listChromeTargetsWithExactAuthority,
  listRemoteChromeTargets,
  type RemoteTargetInfo,
  type RetainedChromeEndpointAuthority,
} from "./chromeLifecycle.js";
import {
  bindPersistedLocalEndpoint,
  requiresExactLocalTargetBinding,
} from "./pendingProcessAcquisition.js";
import {
  recoveryCleanupResourceKey,
  removeReleasedLeaseAuthority,
  requestsProcessTeardown,
  teardownOnlyEntry,
  validateGroupTeardownInvariants,
} from "./recoveryCleanupIdentity.js";
import {
  teardownLocalRecoveryGroup,
  teardownManualLoginRecoveryGroupIfNoActiveLeases,
} from "./recoveryProfileCleanup.js";
import type {
  ReattachCleanupDeps,
  ReattachSettlementMode,
  RecoveryCleanupEntry,
  RecoveryCleanupGroup,
  RecoveryCleanupPhaseResult,
} from "./reattachCleanupTypes.js";
import { inferPortFromBrowserWSEndpoint } from "./reattachRuntime.js";
import { releaseBrowserTabLease } from "./tabLeaseRegistry.js";
import type { BrowserLogger } from "./types.js";
export async function finalizeLocalRecoveryCleanupGroup(
  group: RecoveryCleanupGroup,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps,
  mode: ReattachSettlementMode,
): Promise<RecoveryCleanupPhaseResult> {
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
