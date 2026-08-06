import type {
  BrowserProcessAcquisitionProvenance,
  BrowserRecoveryCleanupResourceMetadata,
  BrowserRecoveryProfileKind,
  BrowserRecoveryTargetCloseCapabilityMetadata,
  BrowserRuntimeMetadata,
} from "../sessionManager.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { ChromeLaunchResult, RetainedChromeEndpointAuthority } from "./chromeLifecycle.js";
import {
  releaseManualChromeOwnerEndpointAuthority,
  settleManualChromeOwner,
  type ManualChromeOwner,
} from "./manualChromeOwner.js";
import {
  isSafeChromeTerminationOutcome,
  removeProfileDirectoryIfIdentityMatches,
  type ChromeOwnerDisposition,
  type ChromeProcessLaunchClaim,
  type ProfileDirectoryIdentity,
} from "./profileState.js";
import {
  releaseBrowserTabLease,
  retainBrowserTabLeaseTeardownAuthority,
  type BrowserTabLease,
  type BrowserTabLeaseReleaseOptions,
  type BrowserTabLeaseTeardownAuthority,
} from "./tabLeaseRegistry.js";
import type { BrowserCaptureFinalizationResult, BrowserLogger } from "./types.js";
import {
  acknowledgeChromeTargetCloseCapability,
  closeChromeTargetWithRetainedCapability,
  discardChromeTargetCloseCapability,
} from "./targetCloseAuthority.js";

export type BrowserCaptureSettlementMode = "finalize" | "abort";

export interface OwnedBrowserResourceTransactionAdapters {
  /** Durable acquisition and bound-pending authority, written before effects. */
  persistRuntime?: (runtime: BrowserRuntimeMetadata) => Promise<BrowserRuntimeMetadata | void>;
  /**
   * Durable completed/failed projection, written after cleanup. Omission keeps terminal target-close
   * capabilities unacknowledged; atomic stores must acknowledge through their own durable authority.
   */
  persistSettlementResult?: (runtime: BrowserRuntimeMetadata) => Promise<void>;
  settleResources: (
    mode: BrowserCaptureSettlementMode,
    pendingRuntime: BrowserRuntimeMetadata,
  ) => Promise<BrowserCaptureFinalizationResult>;
}

export interface OwnedBrowserAcquisitionStep<T> {
  intentRuntime: BrowserRuntimeMetadata;
  acquire: () => Promise<T>;
  acquiredRuntime: (resource: T) => BrowserRuntimeMetadata;
}
interface OwnedBrowserAcquisitionIntent {
  generationId: string;
  pendingResource: "tab-lease" | "chrome-process" | "chrome-target";
}

type OwnedBrowserResourceTransactionState =
  | { kind: "open"; runtime: BrowserRuntimeMetadata }
  | {
      kind: "binding";
      mode: BrowserCaptureSettlementMode;
      runtime: BrowserRuntimeMetadata;
      completion: Promise<BrowserRuntimeMetadata>;
    }
  | {
      kind: "binding-pending";
      mode: BrowserCaptureSettlementMode;
      runtime: BrowserRuntimeMetadata;
    }
  | { kind: "bound"; mode: BrowserCaptureSettlementMode; runtime: BrowserRuntimeMetadata }
  | {
      kind: "settling";
      mode: BrowserCaptureSettlementMode;
      runtime: BrowserRuntimeMetadata;
      completion: Promise<BrowserCaptureFinalizationResult>;
    }
  | {
      kind: "completed";
      mode: BrowserCaptureSettlementMode;
      result: Extract<BrowserCaptureFinalizationResult, { status: "completed" }>;
    }
  | {
      kind: "cleanup-pending";
      mode: BrowserCaptureSettlementMode;
      result: Extract<BrowserCaptureFinalizationResult, { status: "pending" }>;
    };

function cleanupSettlementMode(
  runtime: BrowserRuntimeMetadata,
): BrowserCaptureSettlementMode | undefined {
  return runtime.recoveryCleanupResult?.settlementMode;
}

function settlementModeConflict(
  requestedMode: BrowserCaptureSettlementMode,
  boundMode: BrowserCaptureSettlementMode,
  phase: string,
): BrowserAutomationError {
  return new BrowserAutomationError(
    `Browser run transaction is already bound to ${boundMode}; ${requestedMode} is not allowed.`,
    {
      stage: "browser-run-lifecycle",
      code: "browser-run-lifecycle-settlement-conflict",
      phase,
      requestedMode,
      boundMode,
    },
  );
}

function isSettlementModeConflict(error: unknown): error is BrowserAutomationError {
  return (
    error instanceof BrowserAutomationError &&
    error.details?.code === "browser-run-lifecycle-settlement-conflict"
  );
}

function isSettlementBindingPersistenceFailure(error: unknown): error is BrowserAutomationError {
  return (
    error instanceof BrowserAutomationError &&
    error.details?.code === "browser-settlement-binding-persistence-failed"
  );
}

function assertSettlementMode(
  runtime: BrowserRuntimeMetadata,
  requestedMode: BrowserCaptureSettlementMode,
  phase: string,
): void {
  const boundMode = cleanupSettlementMode(runtime);
  if (boundMode && boundMode !== requestedMode) {
    throw settlementModeConflict(requestedMode, boundMode, phase);
  }
}

function acquisitionIntent(runtime: BrowserRuntimeMetadata): OwnedBrowserAcquisitionIntent {
  const pending = (runtime.recoveryCleanupResources ?? [])
    .map((resource) => resource.acquisition)
    .filter(
      (
        acquisition,
      ): acquisition is NonNullable<typeof acquisition> & {
        pendingResource: "tab-lease" | "chrome-process" | "chrome-target";
      } => Boolean(acquisition?.generationId && acquisition.pendingResource),
    );
  if (pending.length !== 1) {
    throw new BrowserAutomationError(
      "Owned browser acquisition intent must name exactly one pending resource generation.",
      {
        stage: "browser-acquisition",
        code: "browser-acquisition-intent-invalid",
        pendingResources: pending.map((entry) => entry.pendingResource),
      },
    );
  }
  return pending[0];
}

function assertAcquiredRuntime(
  intent: OwnedBrowserAcquisitionIntent,
  runtime: BrowserRuntimeMetadata,
): void {
  const matching = (runtime.recoveryCleanupResources ?? []).find(
    (resource) => resource.acquisition?.generationId === intent.generationId,
  );
  if (!matching) {
    throw new BrowserAutomationError(
      "Owned browser acquisition result lost its durable generation identity.",
      {
        stage: "browser-acquisition",
        code: "browser-acquisition-generation-missing",
        generationId: intent.generationId,
        pendingResource: intent.pendingResource,
      },
    );
  }
  if (matching.acquisition?.pendingResource) {
    throw new BrowserAutomationError(
      "Owned browser acquisition result must clear the completed pending-resource marker.",
      {
        stage: "browser-acquisition",
        code: "browser-acquisition-result-still-pending",
        generationId: intent.generationId,
        pendingResource: matching.acquisition.pendingResource,
      },
    );
  }
  const exactAuthorityPresent =
    intent.pendingResource === "tab-lease"
      ? Boolean(matching.tabLease?.id && matching.tabLease.profileDirectory)
      : intent.pendingResource === "chrome-process"
        ? Boolean(matching.chromeProcessIdentity)
        : Boolean(
            matching.chromeTargetId &&
            matching.acquisition?.targetMarkerUrl &&
            matching.targetCloseCapability?.generationId === intent.generationId &&
            matching.targetCloseCapability.capabilityId,
          );
  if (!exactAuthorityPresent) {
    throw new BrowserAutomationError(
      `Owned browser acquisition result did not persist exact ${intent.pendingResource} authority.`,
      {
        stage: "browser-acquisition",
        code: "browser-acquisition-authority-missing",
        generationId: intent.generationId,
        pendingResource: intent.pendingResource,
      },
    );
  }
}

export function markBrowserCaptureCleanupPending(
  runtime: BrowserRuntimeMetadata,
  settlementMode?: BrowserCaptureSettlementMode,
): BrowserRuntimeMetadata {
  const hasCleanupAuthority = Boolean(
    runtime.recoveryCleanupResources?.length || runtime.recoveryCleanupResult,
  );
  if (!hasCleanupAuthority) return runtime;
  const boundMode = cleanupSettlementMode(runtime);
  if (boundMode && settlementMode && boundMode !== settlementMode) {
    throw settlementModeConflict(settlementMode, boundMode, "runtime-projection");
  }
  return {
    ...runtime,
    recoveryCleanupResult: {
      status: "pending",
      ...(settlementMode || boundMode ? { settlementMode: settlementMode ?? boundMode } : {}),
    },
  };
}

function projectPendingBrowserCleanupAuthority(
  runtime: BrowserRuntimeMetadata,
): BrowserRuntimeMetadata {
  if (!runtime.recoveryCleanupResources?.length || runtime.recoveryCleanupResult) return runtime;
  return markBrowserCaptureCleanupPending(runtime);
}

export async function acknowledgeSettledTargetCloseCapabilities(
  beforeSettlement: BrowserRuntimeMetadata,
  persistedSettlement: BrowserRuntimeMetadata,
): Promise<void> {
  for (const resource of beforeSettlement.recoveryCleanupResources ?? []) {
    const capability = resource.targetCloseCapability;
    if (
      !capability ||
      !resource.chromeTargetId ||
      persistedSettlement.recoveryCleanupResources?.some(
        (persistedResource) =>
          persistedResource.targetCloseCapability?.generationId === capability.generationId &&
          persistedResource.targetCloseCapability.capabilityId === capability.capabilityId,
      )
    ) {
      continue;
    }
    if (resource.recoveryCleanup.closeOwnedTargetOnComplete === false) {
      await discardChromeTargetCloseCapability({
        capability,
        targetId: resource.chromeTargetId,
      });
    } else if (resource.recoveryCleanup.closeOwnedTargetOnComplete === true) {
      acknowledgeChromeTargetCloseCapability({
        capability,
        targetId: resource.chromeTargetId,
      });
    }
  }
}

export function completedBrowserCaptureCleanup(
  runtime: BrowserRuntimeMetadata,
): BrowserCaptureFinalizationResult {
  const completed = { ...runtime };
  delete completed.recoveryCleanupResources;
  delete completed.recoveryCleanupResult;
  return { status: "completed", runtime: completed };
}

export function pendingBrowserCaptureCleanup(
  runtime: BrowserRuntimeMetadata,
  error: string,
  settlementMode?: BrowserCaptureSettlementMode,
): BrowserCaptureFinalizationResult {
  const hasCleanupAuthority = Boolean(
    runtime.recoveryCleanupResources?.length || runtime.recoveryCleanupResult,
  );
  const boundMode = cleanupSettlementMode(runtime);
  if (boundMode && settlementMode && boundMode !== settlementMode) {
    throw settlementModeConflict(settlementMode, boundMode, "runtime-projection");
  }
  return {
    status: "pending",
    runtime: hasCleanupAuthority
      ? {
          ...runtime,
          recoveryCleanupResult: {
            status: "failed",
            error,
            ...(settlementMode || boundMode ? { settlementMode: settlementMode ?? boundMode } : {}),
          },
        }
      : runtime,
    error,
  };
}

export function bindBrowserCaptureCleanupSettlement(
  result: BrowserCaptureFinalizationResult,
  settlementMode: BrowserCaptureSettlementMode,
): BrowserCaptureFinalizationResult {
  if (result.status === "completed") return result;
  const hasCleanupAuthority = Boolean(
    result.runtime.recoveryCleanupResources?.length || result.runtime.recoveryCleanupResult,
  );
  if (!hasCleanupAuthority) return result;
  assertSettlementMode(result.runtime, settlementMode, "runtime-projection");
  const cleanupResult = result.runtime.recoveryCleanupResult;
  return {
    ...result,
    runtime: {
      ...result.runtime,
      recoveryCleanupResult: {
        status: cleanupResult?.status ?? "failed",
        error: cleanupResult?.error ?? result.error,
        settlementMode,
        ...(cleanupResult?.lockReleasePending ? { lockReleasePending: true } : {}),
      },
    },
  };
}

/**
 * Project resource cleanup progress onto the authoritative runtime without allowing a resource
 * adapter to erase prompt-epoch or conversation identity. Resource adapters own target and cleanup
 * fields only; the lifecycle controller owns the published runtime.
 */
export function projectBrowserCaptureCleanupRuntime(
  authoritativeRuntime: BrowserRuntimeMetadata,
  resourceRuntime: BrowserRuntimeMetadata,
): BrowserRuntimeMetadata {
  const conversationId = authoritativeRuntime.conversationId ?? resourceRuntime.conversationId;
  const promptEpoch = authoritativeRuntime.promptEpoch ?? resourceRuntime.promptEpoch;
  const projected: BrowserRuntimeMetadata = {
    ...resourceRuntime,
    ...authoritativeRuntime,
    chromeTargetId: resourceRuntime.chromeTargetId,
    conversationId,
    promptEpoch,
  };
  if (resourceRuntime.recoveryCleanupResources) {
    projected.recoveryCleanupResources = resourceRuntime.recoveryCleanupResources.map(
      (resource) => ({
        ...resource,
        conversationId: conversationId ?? resource.conversationId,
        promptEpoch: promptEpoch ?? resource.promptEpoch,
      }),
    );
  } else {
    delete projected.recoveryCleanupResources;
  }
  if (resourceRuntime.recoveryCleanupResult) {
    projected.recoveryCleanupResult = resourceRuntime.recoveryCleanupResult;
  } else {
    delete projected.recoveryCleanupResult;
  }
  return projected;
}

export function projectBrowserCaptureFinalization(
  authoritativeRuntime: BrowserRuntimeMetadata,
  result: BrowserCaptureFinalizationResult,
  settlementMode?: BrowserCaptureSettlementMode,
): BrowserCaptureFinalizationResult {
  if (settlementMode) {
    assertSettlementMode(authoritativeRuntime, settlementMode, "authoritative-runtime");
    assertSettlementMode(result.runtime, settlementMode, "resource-runtime");
  }
  const projectedRuntime = projectBrowserCaptureCleanupRuntime(
    authoritativeRuntime,
    result.runtime,
  );
  const projected =
    result.status === "completed"
      ? ({ status: "completed", runtime: projectedRuntime } as const)
      : ({ ...result, runtime: projectedRuntime } as const);
  return settlementMode
    ? bindBrowserCaptureCleanupSettlement(projected, settlementMode)
    : projected;
}

export function projectBrowserRetryableCleanupRuntime(
  runtime: BrowserRuntimeMetadata,
  completed: {
    targetId?: string | null;
    targetCloseCapability?: {
      generationId: string;
      capabilityId: string;
    } | null;
    tabLeaseId?: string | null;
  },
): BrowserRuntimeMetadata {
  const targetId = completed.targetId ?? null;
  const targetCloseCapability = completed.targetCloseCapability ?? null;
  const tabLeaseId = completed.tabLeaseId ?? null;
  if (!targetId && !tabLeaseId) return runtime;
  let targetAuthoritySettled = false;
  const resources = runtime.recoveryCleanupResources?.map((resource) => {
    const capabilityMatches = targetCloseCapability
      ? resource.targetCloseCapability?.generationId === targetCloseCapability.generationId &&
        resource.targetCloseCapability.capabilityId === targetCloseCapability.capabilityId
      : true;
    const targetCompleted = Boolean(
      targetId && resource.chromeTargetId === targetId && capabilityMatches,
    );
    if (targetCompleted) targetAuthoritySettled = true;
    const leaseCompleted = Boolean(tabLeaseId && resource.tabLease?.id === tabLeaseId);
    if (!targetCompleted && !leaseCompleted) return resource;
    return {
      ...resource,
      ...(targetCompleted ? { chromeTargetId: undefined, targetCloseCapability: undefined } : {}),
      ...(leaseCompleted ? { tabLease: undefined } : {}),
      recoveryCleanup: targetCompleted
        ? {
            ...resource.recoveryCleanup,
            ownsTarget: false,
            closeOwnedTargetOnComplete: undefined,
          }
        : resource.recoveryCleanup,
    };
  });
  return {
    ...runtime,
    ...(targetAuthoritySettled && runtime.chromeTargetId === targetId
      ? { chromeTargetId: undefined }
      : {}),
    ...(resources ? { recoveryCleanupResources: resources } : {}),
  };
}

/**
 * Canonical owner of resource acquisition ordering, settlement binding, and cleanup retry state.
 * Publication phases, acknowledgement, recovery-lock lifetime, and final session persistence stay
 * with BrowserPublicationTransaction; callers provide resource effects only.
 */
export class OwnedBrowserResourceTransaction {
  private state: OwnedBrowserResourceTransactionState;

  constructor(
    private readonly adapters: OwnedBrowserResourceTransactionAdapters,
    runtime: BrowserRuntimeMetadata,
  ) {
    const projectedRuntime = projectPendingBrowserCleanupAuthority(runtime);
    const boundMode = cleanupSettlementMode(projectedRuntime);
    this.state = boundMode
      ? { kind: "bound", mode: boundMode, runtime: projectedRuntime }
      : { kind: "open", runtime: projectedRuntime };
  }

  runtime(): BrowserRuntimeMetadata {
    if (
      this.state.kind === "open" ||
      this.state.kind === "binding" ||
      this.state.kind === "binding-pending" ||
      this.state.kind === "bound" ||
      this.state.kind === "settling"
    ) {
      return this.state.runtime;
    }
    return this.state.result.runtime;
  }

  replaceRuntime(runtime: BrowserRuntimeMetadata): void {
    if (this.state.kind !== "open") {
      throw new BrowserAutomationError(
        "Owned browser runtime cannot be replaced after settlement has started.",
        {
          stage: "browser-run-lifecycle",
          code: "browser-runtime-replacement-after-settlement",
          phase: this.state.kind,
        },
      );
    }
    this.state = { kind: "open", runtime: projectPendingBrowserCleanupAuthority(runtime) };
  }

  async persist(runtime: BrowserRuntimeMetadata): Promise<void> {
    if (this.state.kind !== "open") {
      throw new BrowserAutomationError(
        "Owned browser runtime cannot be journaled after settlement has started.",
        {
          stage: "browser-run-lifecycle",
          code: "browser-runtime-journal-after-settlement",
          phase: this.state.kind,
        },
      );
    }
    const projectedRuntime = projectPendingBrowserCleanupAuthority(runtime);
    this.state = { kind: "open", runtime: projectedRuntime };
    await this.adapters.persistRuntime?.(projectedRuntime);
  }

  async journalAcquisition<T>(step: OwnedBrowserAcquisitionStep<T>): Promise<T> {
    if (this.state.kind !== "open") {
      throw new BrowserAutomationError(
        "Owned browser acquisition cannot start after settlement has begun.",
        {
          stage: "browser-acquisition",
          code: "browser-acquisition-after-settlement",
          phase: this.state.kind,
        },
      );
    }
    const intent = acquisitionIntent(step.intentRuntime);
    await this.persist(step.intentRuntime);
    const acquired = await step.acquire();
    const acquiredRuntime = projectPendingBrowserCleanupAuthority(step.acquiredRuntime(acquired));
    assertAcquiredRuntime(intent, acquiredRuntime);
    await this.persist(acquiredRuntime);
    return acquired;
  }

  bindSettlement(mode: BrowserCaptureSettlementMode): Promise<BrowserRuntimeMetadata> {
    if (this.state.kind === "open") {
      assertSettlementMode(this.state.runtime, mode, "open");
      return this.beginSettlementBinding(mode, this.state.runtime);
    }
    if (this.state.kind === "binding") {
      if (this.state.mode !== mode) {
        return Promise.reject(settlementModeConflict(mode, this.state.mode, this.state.kind));
      }
      return this.state.completion;
    }
    if (this.state.kind === "binding-pending") {
      if (this.state.mode !== mode) {
        return Promise.reject(settlementModeConflict(mode, this.state.mode, this.state.kind));
      }
      return this.beginSettlementBinding(mode, this.state.runtime);
    }
    if (this.state.mode !== mode) {
      return Promise.reject(settlementModeConflict(mode, this.state.mode, this.state.kind));
    }
    return Promise.resolve(this.runtime());
  }

  settle(mode: BrowserCaptureSettlementMode): Promise<BrowserCaptureFinalizationResult> {
    if (
      this.state.kind === "open" ||
      this.state.kind === "binding" ||
      this.state.kind === "binding-pending"
    ) {
      return this.bindSettlement(mode).then(
        () => this.settle(mode),
        (error: unknown) => {
          if (!isSettlementBindingPersistenceFailure(error)) throw error;
          return { status: "pending" as const, runtime: this.runtime(), error: error.message };
        },
      );
    }
    if (this.state.kind === "bound") {
      if (this.state.mode !== mode) {
        return Promise.reject(settlementModeConflict(mode, this.state.mode, this.state.kind));
      }
      return this.beginSettlement(mode, this.state.runtime);
    }
    if (this.state.kind === "settling") {
      if (this.state.mode !== mode) {
        return Promise.reject(settlementModeConflict(mode, this.state.mode, this.state.kind));
      }
      return this.state.completion;
    }
    if (this.state.kind === "cleanup-pending") {
      if (this.state.mode !== mode) {
        return Promise.reject(settlementModeConflict(mode, this.state.mode, this.state.kind));
      }
      return this.beginSettlement(mode, this.state.result.runtime);
    }
    if (this.state.mode !== mode) {
      return Promise.reject(settlementModeConflict(mode, this.state.mode, this.state.kind));
    }
    return Promise.resolve(this.state.result);
  }

  private beginSettlementBinding(
    mode: BrowserCaptureSettlementMode,
    runtime: BrowserRuntimeMetadata,
  ): Promise<BrowserRuntimeMetadata> {
    const boundRuntime = markBrowserCaptureCleanupPending(runtime, mode);
    const completion = Promise.resolve()
      .then(async () => {
        const persistedRuntime = await this.adapters.persistRuntime?.(boundRuntime);
        const authoritativeBoundRuntime = persistedRuntime ?? boundRuntime;
        this.state = { kind: "bound", mode, runtime: authoritativeBoundRuntime };
        return authoritativeBoundRuntime;
      })
      .catch((error) => {
        if (isSettlementModeConflict(error)) {
          this.state = { kind: "open", runtime };
          throw error;
        }
        this.state = { kind: "binding-pending", mode, runtime: boundRuntime };
        throw new BrowserAutomationError(
          `Browser ${mode} authority could not be durably bound before cleanup.`,
          {
            stage: "browser-run-lifecycle",
            code: "browser-settlement-binding-persistence-failed",
            requestedMode: mode,
            runtime: boundRuntime,
          },
          error,
        );
      });
    this.state = { kind: "binding", mode, runtime: boundRuntime, completion };
    return completion;
  }

  private beginSettlement(
    mode: BrowserCaptureSettlementMode,
    runtime: BrowserRuntimeMetadata,
  ): Promise<BrowserCaptureFinalizationResult> {
    const boundRuntime = markBrowserCaptureCleanupPending(runtime, mode);
    const completion = Promise.resolve()
      .then(async () => {
        const resourceResult = await this.adapters.settleResources(mode, boundRuntime);
        return projectBrowserCaptureFinalization(boundRuntime, resourceResult, mode);
      })
      .catch((error) => {
        if (
          error instanceof BrowserAutomationError &&
          error.details?.code === "browser-run-lifecycle-settlement-conflict"
        ) {
          this.state = { kind: "bound", mode, runtime };
          throw error;
        }
        return pendingBrowserCaptureCleanup(
          boundRuntime,
          error instanceof Error ? error.message : String(error),
          mode,
        );
      })
      .then(async (result) => {
        const boundResult = bindBrowserCaptureCleanupSettlement(result, mode);
        try {
          if (this.adapters.persistSettlementResult) {
            await this.adapters.persistSettlementResult(boundResult.runtime);
            await acknowledgeSettledTargetCloseCapabilities(boundRuntime, boundResult.runtime);
          }
        } catch (error) {
          const retryRuntime =
            boundResult.status === "pending" ? boundResult.runtime : boundRuntime;
          const pending = pendingBrowserCaptureCleanup(
            retryRuntime,
            `Browser settlement result persistence failed: ${error instanceof Error ? error.message : String(error)}`,
            mode,
          );
          if (pending.status === "pending") {
            this.state = { kind: "cleanup-pending", mode, result: pending };
          }
          if (
            error instanceof BrowserAutomationError &&
            error.details?.code === "browser-run-lifecycle-settlement-conflict"
          ) {
            throw error;
          }
          return pending;
        }
        this.state =
          boundResult.status === "completed"
            ? { kind: "completed", mode, result: boundResult }
            : { kind: "cleanup-pending", mode, result: boundResult };
        return boundResult;
      });
    this.state = { kind: "settling", mode, runtime: boundRuntime, completion };
    return completion;
  }
}

export type LocalOwnedBrowserPendingResource = "tab-lease" | "chrome-process" | "chrome-target";

export type LocalOwnedBrowserProcessAuthority =
  | { kind: "manual"; owner: ManualChromeOwner }
  | { kind: "temporary"; chrome: ChromeLaunchResult };

export type LocalOwnedBrowserProcessSettlement =
  | { status: "completed"; disposition: "terminated" | "preserved" }
  | { status: "pending"; reason: string };

export interface LocalOwnedBrowserTargetAuthority {
  targetId: string;
  releasesProcessEndpointOnSettle?: boolean;
  capability: BrowserRecoveryTargetCloseCapabilityMetadata;
  disconnect?: () => Promise<void>;
}

export type LocalOwnedBrowserAcquisitionStep<T> =
  | {
      resource: "tab-lease";
      acquire: () => Promise<T>;
      authority: (resource: T) => BrowserTabLease;
    }
  | {
      resource: "chrome-process";
      acquire: () => Promise<T>;
      authority: (resource: T) => LocalOwnedBrowserProcessAuthority;
    }
  | {
      resource: "chrome-target";
      acquire: () => Promise<T>;
      authority: (resource: T) => LocalOwnedBrowserTargetAuthority;
    };

export interface LocalOwnedBrowserResourceAuthorityOptions {
  purpose: string;
  targetLabel: string;
  baseRuntime?: BrowserRuntimeMetadata;
  userDataDir: string;
  profileDirectoryIdentity: ProfileDirectoryIdentity;
  profileKind: BrowserRecoveryProfileKind;
  keepBrowser: boolean;
  closeOwnedTargetOnComplete: boolean;
  generationId: string;
  processOwnerProvenance: BrowserProcessAcquisitionProvenance;
  processLaunchClaim: ChromeProcessLaunchClaim;
  processOwnerDisposition: ChromeOwnerDisposition;
  leaseId?: string;
  targetMarkerUrl: string;
  tabUrl?: string;
  logger: BrowserLogger;
  disconnectBeforeTarget?: boolean;
  disconnectErrorPrefix?: string;
  manualProcessErrorPrefix?: string;
  persistRuntime?: (runtime: BrowserRuntimeMetadata) => Promise<BrowserRuntimeMetadata | void>;
  persistSettlementResult?: (runtime: BrowserRuntimeMetadata) => Promise<void>;
  releaseLease?: (lease: BrowserTabLease, options?: BrowserTabLeaseReleaseOptions) => Promise<void>;
  settleManualProcess?: (owner: ManualChromeOwner) => Promise<LocalOwnedBrowserProcessSettlement>;
  settleTemporaryProcess?: (
    chrome: ChromeLaunchResult,
  ) => Promise<LocalOwnedBrowserProcessSettlement>;
  settleRemainingResources?: (
    mode: BrowserCaptureSettlementMode,
    runtime: BrowserRuntimeMetadata,
  ) => Promise<BrowserCaptureFinalizationResult>;
}

/**
 * Local target, lease, and process authority shared by every owned-browser feature lane.
 * Acquisition effects stay with callers; this owner alone projects their durable authority and
 * settles it in target -> lease -> process order.
 */
export class LocalOwnedBrowserResourceAuthority {
  private readonly transaction: OwnedBrowserResourceTransaction;
  private baseRuntime: BrowserRuntimeMetadata;
  private inheritedResources: BrowserRecoveryCleanupResourceMetadata[];
  private pendingResource: LocalOwnedBrowserPendingResource | undefined;
  private lease: BrowserTabLease | null = null;
  private process: LocalOwnedBrowserProcessAuthority | null = null;
  private target: LocalOwnedBrowserTargetAuthority | null = null;
  private leaseTeardownAuthority: BrowserTabLeaseTeardownAuthority | null = null;
  private leaseProcessSettlement: LocalOwnedBrowserProcessSettlement | null = null;
  private targetSettled = false;
  private leaseSettled = false;
  private processSettled = false;
  private connectionDisconnected = false;
  private pendingAcquisitionEffectStarted = false;
  private settlementMode: BrowserCaptureSettlementMode | undefined;

  constructor(private readonly options: LocalOwnedBrowserResourceAuthorityOptions) {
    this.baseRuntime = options.baseRuntime ?? {};
    this.inheritedResources = [...(this.baseRuntime.recoveryCleanupResources ?? [])];
    this.transaction = new OwnedBrowserResourceTransaction(
      {
        ...(options.persistRuntime ? { persistRuntime: options.persistRuntime } : {}),
        ...(options.persistSettlementResult
          ? { persistSettlementResult: options.persistSettlementResult }
          : {}),
        settleResources: (mode, runtime) => this.settleResources(mode, runtime),
      },
      this.projectRuntime(),
    );
  }

  runtime(): BrowserRuntimeMetadata {
    return this.transaction.runtime();
  }

  acquiredLease(): BrowserTabLease | null {
    return this.lease;
  }

  acquiredChrome(): ChromeLaunchResult {
    const chrome = this.chrome();
    if (!chrome) throw new Error(`${this.options.purpose} Chrome acquisition is incomplete.`);
    return chrome;
  }

  endpointAuthority(): RetainedChromeEndpointAuthority | undefined {
    if (this.process?.kind === "manual") {
      return this.process.owner.endpointAuthority ?? this.process.owner.chrome.endpointAuthority;
    }
    return this.process?.chrome.endpointAuthority;
  }

  async journalAcquisition<T>(step: LocalOwnedBrowserAcquisitionStep<T>): Promise<T> {
    this.pendingResource = step.resource;
    this.pendingAcquisitionEffectStarted = false;
    return await this.transaction.journalAcquisition({
      intentRuntime: this.projectRuntime(),
      acquire: async () => {
        this.pendingAcquisitionEffectStarted = true;
        return await step.acquire();
      },
      acquiredRuntime: (resource) => {
        if (step.resource === "tab-lease") {
          this.lease = step.authority(resource);
          this.leaseSettled = false;
        } else if (step.resource === "chrome-process") {
          this.process = step.authority(resource);
          this.processSettled = false;
          this.leaseProcessSettlement = null;
          this.retainLeaseTeardownAuthority();
        } else {
          this.target = step.authority(resource);
          this.targetSettled = false;
          this.connectionDisconnected = false;
        }
        this.pendingResource = undefined;
        return this.projectRuntime();
      },
    });
  }

  async disconnect(): Promise<void> {
    if (this.connectionDisconnected || !this.target?.disconnect) return;
    try {
      await this.target.disconnect();
      this.connectionDisconnected = true;
    } catch (error) {
      if (this.options.disconnectErrorPrefix) {
        throw new Error(
          `${this.options.disconnectErrorPrefix}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.connectionDisconnected = true;
    }
  }

  settle(
    mode: BrowserCaptureSettlementMode,
    authoritativeRuntime?: BrowserRuntimeMetadata,
  ): Promise<BrowserCaptureFinalizationResult> {
    const current = this.transaction.runtime();
    if (
      authoritativeRuntime &&
      current.recoveryCleanupResources?.length &&
      !current.recoveryCleanupResult?.settlementMode
    ) {
      this.baseRuntime = authoritativeRuntime;
      this.transaction.replaceRuntime(
        projectBrowserCaptureCleanupRuntime(authoritativeRuntime, this.projectRuntime()),
      );
    }
    return this.transaction.settle(mode);
  }

  private chrome(): ChromeLaunchResult | null {
    if (!this.process) return null;
    return this.process.kind === "manual" ? this.process.owner.chrome : this.process.chrome;
  }

  private processIdentity() {
    if (!this.process) return undefined;
    return this.process.kind === "manual"
      ? this.process.owner.processIdentity
      : this.process.chrome.processIdentity;
  }

  private processDisposition(): ChromeOwnerDisposition {
    if (this.process?.kind === "manual") return this.process.owner.disposition;
    return this.options.processOwnerDisposition;
  }

  private keepBrowser(): boolean {
    return this.options.keepBrowser || this.processDisposition() === "preserve";
  }

  private retainLeaseTeardownAuthority(): void {
    if (
      !this.lease ||
      this.process?.kind !== "manual" ||
      this.process.owner.disposition !== "close-on-last-lease"
    ) {
      return;
    }
    const owner = this.process.owner;
    const onActiveLeaseHandoff = () => releaseManualChromeOwnerEndpointAuthority(owner);
    this.leaseTeardownAuthority = this.options.releaseLease
      ? this.createLeaseTeardownAuthority(this.lease, onActiveLeaseHandoff)
      : retainBrowserTabLeaseTeardownAuthority(this.options.userDataDir, this.lease, {
          logger: this.options.logger,
          onActiveLeaseHandoff,
        });
  }

  private createLeaseTeardownAuthority(
    lease: BrowserTabLease,
    onActiveLeaseHandoff: () => Promise<void>,
  ): BrowserTabLeaseTeardownAuthority {
    let leaseReleased = false;
    let lastLeaseConfirmed = false;
    let handoffPending = false;
    let terminalDisposition: "teardown-completed" | "active-lease-handoff" | null = null;
    return {
      get leaseReleased() {
        return leaseReleased;
      },
      settle: async (teardown) => {
        if (terminalDisposition) {
          return { status: "completed", disposition: terminalDisposition };
        }
        if (handoffPending) {
          try {
            await onActiveLeaseHandoff();
            handoffPending = false;
            terminalDisposition = "active-lease-handoff";
            return { status: "completed", disposition: terminalDisposition };
          } catch (error) {
            return {
              status: "preserved",
              reason: "teardown-unsafe",
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
        let teardownAttempted = false;
        let teardownCompleted = false;
        let activeLeaseHandoff = false;
        try {
          await this.options.releaseLease!(lease, {
            onRelease: async ({ isLastLease }) => {
              leaseReleased = true;
              if (!isLastLease) {
                handoffPending = true;
                await onActiveLeaseHandoff();
                handoffPending = false;
                activeLeaseHandoff = true;
                return;
              }
              lastLeaseConfirmed = true;
              teardownAttempted = true;
              teardownCompleted = await teardown();
            },
          });
        } catch (error) {
          return {
            status: "preserved",
            reason: handoffPending ? "teardown-unsafe" : "registry-unavailable",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (activeLeaseHandoff) {
          terminalDisposition = "active-lease-handoff";
          return { status: "completed", disposition: terminalDisposition };
        }
        if (!teardownAttempted) {
          if (!leaseReleased || !lastLeaseConfirmed) {
            return { status: "preserved", reason: "registry-unavailable" };
          }
          teardownCompleted = await teardown();
        }
        if (!teardownCompleted) return { status: "preserved", reason: "teardown-unsafe" };
        terminalDisposition = "teardown-completed";
        return { status: "completed", disposition: terminalDisposition };
      },
    };
  }

  private projectRuntime(mode = this.settlementMode): BrowserRuntimeMetadata {
    const chrome = this.chrome();
    const processIdentity = this.processIdentity();
    const targetPending =
      this.pendingResource === "chrome-target" || Boolean(this.target && !this.targetSettled);
    const leasePending =
      this.pendingResource === "tab-lease" || Boolean(this.lease && !this.leaseSettled);
    const processPending =
      this.pendingResource === "chrome-process" || Boolean(this.process && !this.processSettled);
    const ownsLocalResources = targetPending || leasePending || processPending;
    const next: BrowserRuntimeMetadata = {
      ...this.baseRuntime,
      browserTransport: "cdp",
      chromePid: chrome?.pid,
      chromeProcessIdentity: processIdentity,
      chromePort: chrome?.port,
      chromeHost: chrome?.host ?? "127.0.0.1",
      chromeBrowserWSEndpoint: this.endpointAuthority()?.browserWSEndpoint,
      chromeProfileRoot: this.options.userDataDir,
      userDataDir: this.options.userDataDir,
      chromeTargetId: targetPending ? (this.target?.targetId ?? undefined) : undefined,
      ...(this.options.tabUrl ? { tabUrl: this.options.tabUrl } : {}),
      controllerPid: process.pid,
    };
    const resources = [...this.inheritedResources];
    if (ownsLocalResources) {
      resources.push({
        chromePid: chrome?.pid,
        chromeProcessIdentity: processIdentity,
        profileDirectoryIdentity:
          processIdentity?.profileDirectory ??
          this.lease?.profileDirectory ??
          this.options.profileDirectoryIdentity,
        chromePort: chrome?.port,
        chromeHost: chrome?.host ?? "127.0.0.1",
        chromeBrowserWSEndpoint: this.endpointAuthority()?.browserWSEndpoint,
        chromeProfileRoot: this.options.userDataDir,
        userDataDir: this.options.userDataDir,
        chromeTargetId: targetPending ? (this.target?.targetId ?? undefined) : undefined,
        targetCloseCapability: targetPending ? this.target?.capability : undefined,
        conversationId: next.conversationId,
        promptEpoch: next.promptEpoch,
        tabLease: leasePending
          ? {
              id: this.lease?.id ?? this.options.leaseId ?? "",
              profileDirectory:
                this.lease?.profileDirectory ?? this.options.profileDirectoryIdentity,
            }
          : undefined,
        acquisition: {
          generationId: this.options.generationId,
          processOwnerProvenance: this.options.processOwnerProvenance,
          processLaunchClaim: this.options.processLaunchClaim,
          processOwnerDisposition: this.processDisposition(),
          ...(this.pendingResource ? { pendingResource: this.pendingResource } : {}),
          targetMarkerUrl: this.options.targetMarkerUrl,
        },
        recoveryCleanup: {
          ownsTarget: targetPending,
          profileKind: this.options.profileKind,
          keepBrowser: this.keepBrowser(),
          ...(targetPending
            ? { closeOwnedTargetOnComplete: this.options.closeOwnedTargetOnComplete }
            : {}),
        },
      });
    }
    if (resources.length > 0) {
      next.recoveryCleanupResources = resources;
      next.recoveryCleanupResult = {
        status: "pending",
        ...(mode ? { settlementMode: mode } : {}),
      };
    } else {
      delete next.recoveryCleanupResources;
      delete next.recoveryCleanupResult;
    }
    return next;
  }

  private async settleResources(
    mode: BrowserCaptureSettlementMode,
    pendingRuntime: BrowserRuntimeMetadata,
  ): Promise<BrowserCaptureFinalizationResult> {
    this.settlementMode = mode;
    this.baseRuntime = pendingRuntime;
    let deferredTargetToProcess = false;

    if (this.options.disconnectBeforeTarget) {
      const error = await this.disconnectError();
      if (error) return pendingBrowserCaptureCleanup(this.projectRuntime(mode), error, mode);
    }

    if (this.pendingResource === "chrome-target" || (this.target && !this.targetSettled)) {
      const resource = pendingRuntime.recoveryCleanupResources?.find(
        (candidate) => candidate.acquisition?.generationId === this.options.generationId,
      );
      const closeTarget = resource?.recoveryCleanup.closeOwnedTargetOnComplete;
      if (typeof closeTarget !== "boolean") {
        return pendingBrowserCaptureCleanup(
          this.projectRuntime(mode),
          `${this.options.targetLabel} target ${mode} disposition is missing`,
          mode,
        );
      }
      if (closeTarget && !this.target) {
        if (
          this.pendingAcquisitionEffectStarted &&
          this.process &&
          !this.processSettled &&
          !this.keepBrowser()
        ) {
          deferredTargetToProcess = true;
        } else {
          return pendingBrowserCaptureCleanup(
            this.projectRuntime(mode),
            `${this.options.targetLabel} target has no retained exact close capability`,
            mode,
          );
        }
      } else {
        if (closeTarget && this.target) {
          try {
            const closed = await closeChromeTargetWithRetainedCapability({
              capability: this.target.capability,
              targetId: this.target.targetId,
              logger: this.options.logger,
            });
            if (closed.status === "unsafe" || closed.status === "unavailable") {
              return pendingBrowserCaptureCleanup(this.projectRuntime(mode), closed.reason, mode);
            }
          } catch (error) {
            return pendingBrowserCaptureCleanup(
              this.projectRuntime(mode),
              `${this.options.targetLabel} target close failed: ${error instanceof Error ? error.message : String(error)}`,
              mode,
            );
          }
        }
        const error = await this.commitAuthorityChange({
          targetSettled: true,
          clearPending: "chrome-target",
        });
        if (error) return pendingBrowserCaptureCleanup(this.projectRuntime(mode), error, mode);
      }
    }

    if (!this.options.disconnectBeforeTarget) {
      const error = await this.disconnectError();
      if (error) return pendingBrowserCaptureCleanup(this.projectRuntime(mode), error, mode);
    }

    if (this.leaseTeardownAuthority && this.process && !this.processSettled) {
      let processEffectAttempted = false;
      const outcome = await this.leaseTeardownAuthority.settle(async () => {
        processEffectAttempted = true;
        this.leaseProcessSettlement = await this.settleProcessEffect();
        return this.leaseProcessSettlement.status === "completed";
      });
      const processSettlement = this.leaseProcessSettlement;
      if (outcome.status === "completed") {
        const processWasTerminated =
          processSettlement?.status === "completed" &&
          processSettlement.disposition === "terminated";
        const error = await this.commitAuthorityChange({
          leaseSettled: true,
          processSettled: true,
          ...(deferredTargetToProcess && processWasTerminated
            ? { targetSettled: true, clearPending: "chrome-target" as const }
            : {}),
        });
        if (error) return pendingBrowserCaptureCleanup(this.projectRuntime(mode), error, mode);
        if (deferredTargetToProcess && !processWasTerminated) {
          const preservationReason =
            outcome.disposition === "active-lease-handoff"
              ? "active-lease handoff"
              : "process preservation";
          return pendingBrowserCaptureCleanup(
            this.projectRuntime(mode),
            `${this.options.targetLabel} target has no retained exact close capability after ${preservationReason}`,
            mode,
          );
        }
      } else {
        if (this.leaseTeardownAuthority.leaseReleased && !this.leaseSettled) {
          const error = await this.commitAuthorityChange({ leaseSettled: true });
          if (error) return pendingBrowserCaptureCleanup(this.projectRuntime(mode), error, mode);
        }
        return pendingBrowserCaptureCleanup(
          this.projectRuntime(mode),
          processEffectAttempted && processSettlement?.status === "pending"
            ? processSettlement.reason
            : (outcome.error ?? outcome.reason),
          mode,
        );
      }
    } else {
      if (this.pendingResource === "tab-lease" || (this.lease && !this.leaseSettled)) {
        try {
          if (this.lease) {
            if (this.options.releaseLease) await this.options.releaseLease(this.lease);
            else await this.lease.release();
          } else if (this.options.leaseId) {
            await releaseBrowserTabLease(
              this.options.userDataDir,
              this.options.leaseId,
              this.options.logger,
              { expectedProfileIdentity: this.options.profileDirectoryIdentity },
            );
          } else {
            throw new Error("lease id is missing");
          }
        } catch (error) {
          return pendingBrowserCaptureCleanup(
            this.projectRuntime(mode),
            `${this.options.purpose} browser lease release failed: ${error instanceof Error ? error.message : String(error)}`,
            mode,
          );
        }
        const error = await this.commitAuthorityChange({
          leaseSettled: true,
          clearPending: "tab-lease",
        });
        if (error) return pendingBrowserCaptureCleanup(this.projectRuntime(mode), error, mode);
      }

      if (this.pendingResource === "chrome-process" && !this.process) {
        return pendingBrowserCaptureCleanup(
          this.projectRuntime(mode),
          `${this.options.purpose} Chrome process acquisition has no exact live owner authority`,
          mode,
        );
      }
      if (this.process && !this.processSettled) {
        const processSettlement = await this.settleProcessEffect();
        if (processSettlement.status === "pending") {
          return pendingBrowserCaptureCleanup(
            this.projectRuntime(mode),
            processSettlement.reason,
            mode,
          );
        }
        const processWasTerminated = processSettlement.disposition === "terminated";
        const error = await this.commitAuthorityChange({
          processSettled: true,
          clearPending: "chrome-process",
          ...(deferredTargetToProcess && processWasTerminated
            ? { targetSettled: true, clearPending: "chrome-target" as const }
            : {}),
        });
        if (error) return pendingBrowserCaptureCleanup(this.projectRuntime(mode), error, mode);
        if (deferredTargetToProcess && !processWasTerminated) {
          return pendingBrowserCaptureCleanup(
            this.projectRuntime(mode),
            `${this.options.targetLabel} target has no retained exact close capability after process preservation`,
            mode,
          );
        }
      }
    }

    const ownedRuntime = this.projectRuntime(mode);
    if (this.inheritedResources.length > 0 && this.options.settleRemainingResources) {
      const result = await this.options.settleRemainingResources(mode, ownedRuntime);
      this.baseRuntime = result.runtime;
      this.inheritedResources = [...(result.runtime.recoveryCleanupResources ?? [])];
      return result;
    }
    return completedBrowserCaptureCleanup(ownedRuntime);
  }

  private async disconnectError(): Promise<string | null> {
    try {
      await this.disconnect();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private async settleProcessEffect(): Promise<LocalOwnedBrowserProcessSettlement> {
    if (!this.process) return { status: "completed", disposition: "preserved" };
    if (this.process.kind === "manual") {
      if (this.options.settleManualProcess) {
        return await this.options.settleManualProcess(this.process.owner);
      }
      const settlement = await settleManualChromeOwner(
        this.options.userDataDir,
        this.process.owner,
        this.options.logger,
      );
      if (settlement.status === "unsafe") {
        return {
          status: "pending",
          reason: this.options.manualProcessErrorPrefix
            ? `${this.options.manualProcessErrorPrefix}: ${settlement.reason}`
            : settlement.reason,
        };
      }
      return {
        status: "completed",
        disposition: settlement.status === "terminated" ? "terminated" : "preserved",
      };
    }
    const chrome = this.process.chrome;
    if (this.options.settleTemporaryProcess) {
      return await this.options.settleTemporaryProcess(chrome);
    }
    if (this.keepBrowser()) {
      if (!this.target?.releasesProcessEndpointOnSettle) {
        try {
          await chrome.endpointAuthority?.release();
        } catch (error) {
          return {
            status: "pending",
            reason: `Exact Chrome endpoint release failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      try {
        chrome.process?.unref?.();
      } catch {
        // Best effort only; retained process ownership is already explicit in runtime metadata.
      }
      this.options.logger(
        `Chrome left running on port ${chrome.port} with profile ${this.options.userDataDir}`,
      );
      return { status: "completed", disposition: "preserved" };
    }
    const termination = await chrome.kill().catch((error: unknown) => ({
      status: "unsafe" as const,
      pid: chrome.pid,
      reason: error instanceof Error ? error.message : String(error),
    }));
    if (!isSafeChromeTerminationOutcome(termination)) {
      return { status: "pending", reason: termination.reason };
    }
    const removed = await removeProfileDirectoryIfIdentityMatches(
      this.options.userDataDir,
      chrome.processIdentity.profileDirectory,
    ).catch(() => false);
    return removed
      ? { status: "completed", disposition: "terminated" }
      : {
          status: "pending",
          reason: `Profile removal was not confirmed: ${this.options.userDataDir}`,
        };
  }

  private async commitAuthorityChange(changes: {
    targetSettled?: boolean;
    leaseSettled?: boolean;
    processSettled?: boolean;
    clearPending?: LocalOwnedBrowserPendingResource;
  }): Promise<string | null> {
    const before = this.projectRuntime(this.settlementMode);
    const previous = {
      targetSettled: this.targetSettled,
      leaseSettled: this.leaseSettled,
      processSettled: this.processSettled,
      pendingResource: this.pendingResource,
    };
    this.applyAuthorityChange(changes);
    const after = this.projectRuntime(this.settlementMode);
    this.targetSettled = previous.targetSettled;
    this.leaseSettled = previous.leaseSettled;
    this.processSettled = previous.processSettled;
    this.pendingResource = previous.pendingResource;
    try {
      await this.options.persistRuntime?.(after);
      await acknowledgeSettledTargetCloseCapabilities(before, after);
    } catch (error) {
      return `Browser authority progress could not be persisted: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.applyAuthorityChange(changes);
    return null;
  }

  private applyAuthorityChange(changes: {
    targetSettled?: boolean;
    leaseSettled?: boolean;
    processSettled?: boolean;
    clearPending?: LocalOwnedBrowserPendingResource;
  }): void {
    if (changes.targetSettled !== undefined) this.targetSettled = changes.targetSettled;
    if (changes.leaseSettled !== undefined) this.leaseSettled = changes.leaseSettled;
    if (changes.processSettled !== undefined) this.processSettled = changes.processSettled;
    if (changes.clearPending === this.pendingResource) this.pendingResource = undefined;
  }
}
