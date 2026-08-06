import type { BrowserRecoveryCleanupResourceMetadata } from "../sessionManager.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { finalizeLocalRecoveryCleanupGroup } from "./localRecoveryCleanup.js";
import { reconcilePendingProcessAcquisitions } from "./pendingProcessAcquisition.js";
import {
  groupRecoveryCleanupResources,
  recoveryCleanupResourceKey,
} from "./recoveryCleanupIdentity.js";
import { finalizeRemoteRecoveryCleanupGroup } from "./remoteRecoverySettlement.js";
import type {
  ReattachCleanupDeps,
  ReattachFinalizationResult,
  ReattachSettlementMode,
  RecoveryCleanupEntry,
  RecoveryCleanupGroup,
  RecoveryCleanupPhaseResult,
} from "./reattachCleanupTypes.js";
import {
  projectBrowserCaptureCleanupRuntime,
  projectBrowserCaptureFinalization,
} from "./ownedBrowserResources.js";
import type { BrowserLogger } from "./types.js";

export {
  chromeProcessIdentityKey,
  defaultRecoveryLockPath,
  immutablePromptIdentity,
  recoveryCleanupGroupKey,
} from "./recoveryCleanupIdentity.js";
export type { ReattachCleanupDeps, ReattachFinalizationResult } from "./reattachCleanupTypes.js";

async function finalizeRecoveryCleanupGroup(
  group: RecoveryCleanupGroup,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps,
  mode: ReattachSettlementMode,
): Promise<RecoveryCleanupPhaseResult> {
  return group.entries[0]?.resource.remoteRecovery
    ? finalizeRemoteRecoveryCleanupGroup(group, deps, mode)
    : finalizeLocalRecoveryCleanupGroup(group, logger, deps, mode);
}

export async function finalizeRecoveredRuntime(
  runtime: BrowserRuntimeMetadata,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps = {},
  mode: ReattachSettlementMode = "finalize",
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
  let classification: RecoveryCleanupPhaseResult["classification"];

  for (const group of groups) {
    const result = await finalizeRecoveryCleanupGroup(group, logger, deps, mode);
    pending.push(...result.pending);
    errors.push(...result.errors);
    classification ??= result.classification;
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
  const pendingRuntime = rebuildPendingCleanupRuntime(
    runtime,
    pending,
    error,
    mode,
    classification,
  );
  return projectBrowserCaptureFinalization(
    runtime,
    { status: "pending", runtime: pendingRuntime, error },
    mode,
  );
}

function rebuildPendingCleanupRuntime(
  runtime: BrowserRuntimeMetadata,
  entries: RecoveryCleanupEntry[],
  error: string,
  settlementMode: ReattachSettlementMode,
  classification?: RecoveryCleanupPhaseResult["classification"],
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
    recoveryCleanupResult: { status: "failed", error, settlementMode, classification },
  });
}

export function pendingFinalization(
  runtime: BrowserRuntimeMetadata,
  error: string,
  settlementMode?: ReattachSettlementMode,
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
