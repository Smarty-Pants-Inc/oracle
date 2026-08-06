import { createHash } from "node:crypto";
import type { RetainedChromeEndpointAuthority } from "./chromeLifecycle.js";
import { bindPersistedLocalEndpoint } from "./pendingProcessAcquisition.js";
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
import { closeChromeTargetWithRetainedCapability } from "./targetCloseAuthority.js";
import type { BrowserLogger } from "./types.js";

export async function finalizeLocalRecoveryCleanupGroup(
  group: RecoveryCleanupGroup,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps,
  _mode: ReattachSettlementMode,
): Promise<RecoveryCleanupPhaseResult> {
  const pending: RecoveryCleanupEntry[] = [];
  const errors: string[] = [];
  const pendingKeys = new Set<string>();
  const releasedLeaseIds = new Set<string>();
  const settledTargetCapabilities = new Set<string>();
  const processSubsumedTargets: RecoveryCleanupEntry[] = [];
  let classification: RecoveryCleanupPhaseResult["classification"];
  const groupLabel = createHash("sha256").update(group.key).digest("hex").slice(0, 12);
  const addPending = (entry: RecoveryCleanupEntry, error: string): void => {
    const capabilityId = entry.resource.targetCloseCapability?.capabilityId;
    const pendingEntry =
      capabilityId && settledTargetCapabilities.has(capabilityId)
        ? teardownOnlyEntry(entry)
        : entry;
    const key = recoveryCleanupResourceKey(pendingEntry.resource);
    if (!pendingKeys.has(key)) {
      pendingKeys.add(key);
      pending.push(pendingEntry);
    }
    errors.push(`Cleanup group ${groupLabel}: ${error}`);
  };
  const retainProcessSubsumedTargets = (error: string): void => {
    for (const entry of processSubsumedTargets) addPending(entry, error);
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
      if (typeof cleanup.closeOwnedTargetOnComplete !== "boolean") {
        addPending(entry, "Owned Chrome target close disposition is missing");
        continue;
      }
      if (!cleanup.closeOwnedTargetOnComplete) continue;
      const targetKey =
        resource.targetCloseCapability?.capabilityId ??
        `missing:${recoveryCleanupResourceKey(resource)}`;
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
    let recordedProcessExited = false;

    const exactTeardownBindingRequired =
      teardownEntries.length > 0 &&
      !preserveProcess &&
      Boolean(teardownEntry?.resource.chromeProcessIdentity) &&
      !deps.terminateExactChromeForProfile;

    if (exactTeardownBindingRequired) {
      if (!connectionResource) {
        if (teardownEntry) {
          addPending(teardownEntry, "Local Chrome cleanup endpoint metadata is missing");
        }
        return { pending, errors };
      }
      try {
        const binding = await bindPersistedLocalEndpoint(connectionResource, deps);
        if (binding.status === "gone") {
          recordedProcessExited = true;
        } else {
          endpointAuthority = binding.authority;
        }
      } catch (error) {
        const message = `Exact Chrome endpoint authentication failed: ${error instanceof Error ? error.message : String(error)}`;
        if (exactTeardownBindingRequired && teardownEntry) addPending(teardownEntry, message);
        return { pending, errors };
      }
    }

    if (!recordedProcessExited) {
      targetCleanup: for (const targetEntries of targets.values()) {
        const representative = targetEntries[0];
        if (!representative) continue;
        const resource = representative.resource;
        const targetId = resource.chromeTargetId;
        const capability = resource.targetCloseCapability;
        if (
          !targetId &&
          resource.acquisition?.pendingResource === "chrome-target" &&
          teardownEntry &&
          teardownEntries.length > 0 &&
          !preserveProcess &&
          (endpointAuthority || deps.terminateExactChromeForProfile)
        ) {
          processSubsumedTargets.push(...targetEntries);
          continue;
        }
        if (!targetId) {
          const message =
            resource.acquisition?.pendingResource === "chrome-target"
              ? "Chrome target acquisition ended before exact target close authority was published; the target was preserved"
              : "Owned Chrome target cleanup metadata is incomplete; the target was preserved";
          for (const entry of targetEntries) addPending(entry, message);
          continue;
        }
        if (!capability) {
          classification = "legacy-session-target-authority";
          for (const entry of targetEntries) {
            addPending(
              entry,
              "Pre-upgrade browser session has no generation-bound target cleanup capability. Oracle cannot safely reconstruct it from the saved endpoint or marker; the target was preserved. Complete or restart the browser session with the current Oracle version",
            );
          }
          continue;
        }
        if (
          resource.acquisition?.generationId &&
          capability.generationId !== resource.acquisition.generationId
        ) {
          for (const entry of targetEntries) {
            addPending(
              entry,
              "Persisted target close capability is not bound to the recorded acquisition generation; the target was preserved",
            );
          }
          continue;
        }
        try {
          const closed = await (
            deps.closeChromeTargetWithRetainedCapability ?? closeChromeTargetWithRetainedCapability
          )({ capability, targetId, logger });
          if (closed.status === "completed" || closed.status === "gone") {
            settledTargetCapabilities.add(capability.capabilityId);
          }
          if (closed.status === "gone") {
            recordedProcessExited = true;
            break targetCleanup;
          }
          if (closed.status === "unsafe" || closed.status === "unavailable") {
            for (const entry of targetEntries) addPending(entry, closed.reason);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          for (const entry of targetEntries) {
            addPending(entry, `Chrome target close failed: ${message}`);
          }
        }
      }
    }

    if (pending.length > 0) {
      if (
        teardownEntry &&
        teardownEntries.length > 0 &&
        !preserveProcess &&
        !pending.some((entry) => requestsProcessTeardown(entry.resource))
      ) {
        addPending(teardownEntry, "Process teardown deferred until target cleanup completes");
      }
      retainProcessSubsumedTargets(
        "Exact process teardown did not run; unresolved target acquisition authority was preserved",
      );
      return { pending, errors, classification };
    }

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
      retainProcessSubsumedTargets(
        "Exact process teardown did not run; unresolved target acquisition authority was preserved",
      );
      return { pending, errors };
    }
    if (manualOwnerRetainedByOtherLease) {
      retainProcessSubsumedTargets(
        "Chrome was retained by another active lease; unresolved target acquisition authority was preserved",
      );
      return { pending, errors };
    }
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
        retainProcessSubsumedTargets(
          "Exact process teardown did not complete; unresolved target acquisition authority was preserved",
        );
      }
    } catch (error) {
      addPending(
        removeReleasedLeaseAuthority(teardownEntry, releasedLeaseIds),
        error instanceof Error ? error.message : String(error),
      );
      retainProcessSubsumedTargets(
        "Exact process teardown did not complete; unresolved target acquisition authority was preserved",
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
