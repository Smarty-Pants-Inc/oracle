import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserCaptureFinalizationResult } from "./types.js";
import {
  acknowledgeChromeTargetCloseCapability,
  discardChromeTargetCloseCapability,
} from "./targetCloseAuthority.js";

export type BrowserCaptureSettlementMode = "finalize" | "abort";

export interface OwnedBrowserResourceTransactionAdapters {
  /** Trusted controller/session owner for live capability acknowledgement. */
  ownerId?: string;
  /** Durable acquisition/runtime projection written outside settlement binding. */
  persistRuntime?: (runtime: BrowserRuntimeMetadata) => Promise<BrowserRuntimeMetadata | void>;
  /** Optional durable authority bind performed before the bound runtime is persisted locally. */
  bindSettlementAuthority?: (
    mode: BrowserCaptureSettlementMode,
    runtime: BrowserRuntimeMetadata,
  ) => Promise<BrowserRuntimeMetadata>;
  /** Durable bound-pending authority, written before settlement effects. */
  persistSettlementBinding?: (
    mode: BrowserCaptureSettlementMode,
    runtime: BrowserRuntimeMetadata,
  ) => Promise<BrowserRuntimeMetadata | void>;
  /** Project mode-specific cleanup policy before the bound runtime is persisted. */
  projectSettlementRuntime?: (
    mode: BrowserCaptureSettlementMode,
    runtime: BrowserRuntimeMetadata,
  ) => BrowserRuntimeMetadata;
  /**
   * Durable completed/failed projection, written after cleanup. Omission keeps terminal target-close
   * capabilities unacknowledged; atomic stores must acknowledge through their own durable authority.
   */
  persistSettlementResult?: (runtime: BrowserRuntimeMetadata) => Promise<void>;
  /** External semantic contract for an opposite-mode operation on authoritative state. */
  settlementModeConflict?: (
    requestedMode: BrowserCaptureSettlementMode,
    boundMode: BrowserCaptureSettlementMode,
    runtime: BrowserRuntimeMetadata,
    phase: string,
  ) => BrowserAutomationError;
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
  | {
      kind: "binding-persistence-pending";
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

function withoutCleanupSettlementMode(runtime: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
  const cleanupResult = runtime.recoveryCleanupResult;
  if (!cleanupResult?.settlementMode) return runtime;
  const { settlementMode: _settlementMode, ...unboundCleanupResult } = cleanupResult;
  return { ...runtime, recoveryCleanupResult: unboundCleanupResult };
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
    (error.details?.code === "browser-run-lifecycle-settlement-conflict" ||
      error.details?.code === "settlement-mode-conflict" ||
      error.details?.code === "remote-settlement-mode-conflict")
  );
}

function isSettlementBindingPersistenceFailure(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  const code = error.details?.code;
  return (
    code === "browser-settlement-binding-persistence-failed" ||
    code === "settlement-authority-persistence-failed" ||
    code === "remote-settlement-binding-transport-failed" ||
    code === "remote-settlement-contention-pending" ||
    code === "remote-artifact-manual-copy-waiver-pending"
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
  ownerId: string,
): Promise<void> {
  const trustedOwnerId = ownerId.trim();
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
    if (!trustedOwnerId) throw new Error("Target close capability owner is unavailable.");
    if (resource.recoveryCleanup.closeOwnedTargetOnComplete === false) {
      await discardChromeTargetCloseCapability({
        ownerId: trustedOwnerId,
        capability,
        targetId: resource.chromeTargetId,
      });
    } else if (resource.recoveryCleanup.closeOwnedTargetOnComplete === true) {
      acknowledgeChromeTargetCloseCapability({
        ownerId: trustedOwnerId,
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
 * Sole typed owner of owned-resource acquisition ordering, settlement mode binding, in-flight
 * settlement, terminal completion, and retry state. Callers provide durable and effect adapters.
 */
export class OwnedBrowserResourceTransaction {
  private state: OwnedBrowserResourceTransactionState;
  private adapters: OwnedBrowserResourceTransactionAdapters;

  constructor(adapters: OwnedBrowserResourceTransactionAdapters, runtime: BrowserRuntimeMetadata) {
    this.adapters = adapters;
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
      this.state.kind === "binding-persistence-pending" ||
      this.state.kind === "bound" ||
      this.state.kind === "settling"
    ) {
      return this.state.runtime;
    }
    return this.state.result.runtime;
  }
  replaceAdapters(adapters: OwnedBrowserResourceTransactionAdapters): void {
    if (this.state.kind !== "open") {
      throw new BrowserAutomationError(
        "Owned browser adapters cannot change after settlement has started.",
        {
          stage: "browser-run-lifecycle",
          code: "browser-adapter-replacement-after-settlement",
          phase: this.state.kind,
        },
      );
    }
    this.adapters = adapters;
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
      const boundMode = cleanupSettlementMode(this.state.runtime);
      if (boundMode && boundMode !== mode) {
        throw this.modeConflict(mode, boundMode, this.state.kind, this.state.runtime);
      }
      return this.beginSettlementBinding(mode, this.state.runtime);
    }
    if (this.state.kind === "binding") {
      if (this.state.mode !== mode) {
        return Promise.reject(
          this.modeConflict(mode, this.state.mode, this.state.kind, this.state.runtime),
        );
      }
      return this.state.completion;
    }
    if (this.state.kind === "binding-pending") {
      if (this.state.mode !== mode) {
        return Promise.reject(
          this.modeConflict(mode, this.state.mode, this.state.kind, this.state.runtime),
        );
      }
      return this.beginSettlementBinding(mode, this.state.runtime);
    }
    if (this.state.kind === "binding-persistence-pending") {
      if (this.state.mode !== mode) {
        return Promise.reject(
          this.modeConflict(mode, this.state.mode, this.state.kind, this.state.runtime),
        );
      }
      return this.beginSettlementPersistence(mode, this.state.runtime);
    }
    if (this.state.mode !== mode) {
      return Promise.reject(
        this.modeConflict(mode, this.state.mode, this.state.kind, this.runtime()),
      );
    }
    return Promise.resolve(this.runtime());
  }

  settle(mode: BrowserCaptureSettlementMode): Promise<BrowserCaptureFinalizationResult> {
    if (
      this.state.kind === "open" ||
      this.state.kind === "binding" ||
      this.state.kind === "binding-pending" ||
      this.state.kind === "binding-persistence-pending"
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
        return Promise.reject(
          this.modeConflict(mode, this.state.mode, this.state.kind, this.state.runtime),
        );
      }
      return this.beginSettlement(mode, this.state.runtime);
    }
    if (this.state.kind === "settling") {
      if (this.state.mode !== mode) {
        return Promise.reject(
          this.modeConflict(mode, this.state.mode, this.state.kind, this.state.runtime),
        );
      }
      return this.state.completion;
    }
    if (this.state.kind === "cleanup-pending") {
      if (this.state.mode !== mode) {
        return Promise.reject(
          this.modeConflict(mode, this.state.mode, this.state.kind, this.state.result.runtime),
        );
      }
      return this.beginSettlement(mode, this.state.result.runtime);
    }
    if (this.state.mode !== mode) {
      return Promise.reject(
        this.modeConflict(mode, this.state.mode, this.state.kind, this.state.result.runtime),
      );
    }
    return Promise.resolve(this.state.result);
  }

  private beginSettlementBinding(
    mode: BrowserCaptureSettlementMode,
    runtime: BrowserRuntimeMetadata,
  ): Promise<BrowserRuntimeMetadata> {
    const settlementRuntime = this.adapters.projectSettlementRuntime?.(mode, runtime) ?? runtime;
    const boundRuntime = markBrowserCaptureCleanupPending(settlementRuntime, mode);
    const completion = Promise.resolve()
      .then(() =>
        this.adapters.bindSettlementAuthority
          ? this.adapters.bindSettlementAuthority(mode, boundRuntime)
          : boundRuntime,
      )
      .catch((error) => this.failSettlementBinding(mode, boundRuntime, error, "binding-pending"))
      .then((authoritativeRuntime) => this.beginSettlementPersistence(mode, authoritativeRuntime));
    this.state = { kind: "binding", mode, runtime: boundRuntime, completion };
    return completion;
  }

  private beginSettlementPersistence(
    mode: BrowserCaptureSettlementMode,
    boundRuntime: BrowserRuntimeMetadata,
  ): Promise<BrowserRuntimeMetadata> {
    const completion = Promise.resolve()
      .then(async () => {
        const persistedRuntime = this.adapters.persistSettlementBinding
          ? await this.adapters.persistSettlementBinding(mode, boundRuntime)
          : await this.adapters.persistRuntime?.(boundRuntime);
        const authoritativeBoundRuntime = persistedRuntime ?? boundRuntime;
        this.state = { kind: "bound", mode, runtime: authoritativeBoundRuntime };
        return authoritativeBoundRuntime;
      })
      .catch((error) =>
        this.failSettlementBinding(mode, boundRuntime, error, "binding-persistence-pending"),
      );
    this.state = { kind: "binding", mode, runtime: boundRuntime, completion };
    return completion;
  }

  private failSettlementBinding(
    mode: BrowserCaptureSettlementMode,
    fallbackRuntime: BrowserRuntimeMetadata,
    error: unknown,
    retryKind: "binding-pending" | "binding-persistence-pending",
  ): never {
    const authoritativeRuntime =
      error instanceof BrowserAutomationError &&
      error.details?.runtime &&
      typeof error.details.runtime === "object" &&
      !Array.isArray(error.details.runtime)
        ? (error.details.runtime as BrowserRuntimeMetadata)
        : undefined;
    const errorRuntime = authoritativeRuntime ?? fallbackRuntime;
    if (isSettlementModeConflict(error)) {
      const settlementAuthority = error.details?.settlementAuthority as
        | { mode?: BrowserCaptureSettlementMode; outcome?: "bound" | "completed" }
        | undefined;
      const reportedBoundMode = error.details?.boundMode as
        | BrowserCaptureSettlementMode
        | undefined;
      const acceptedRuntime =
        authoritativeRuntime &&
        cleanupSettlementMode(authoritativeRuntime) === mode &&
        reportedBoundMode &&
        reportedBoundMode !== mode &&
        !settlementAuthority
          ? undefined
          : authoritativeRuntime;
      if (
        acceptedRuntime &&
        settlementAuthority?.mode &&
        settlementAuthority.outcome === "completed"
      ) {
        this.state = {
          kind: "completed",
          mode: settlementAuthority.mode,
          result: { status: "completed", runtime: acceptedRuntime },
        };
      } else if (acceptedRuntime) {
        const authoritativeMode =
          cleanupSettlementMode(acceptedRuntime) ?? settlementAuthority?.mode;
        this.state = authoritativeMode
          ? { kind: "bound", mode: authoritativeMode, runtime: acceptedRuntime }
          : { kind: "open", runtime: withoutCleanupSettlementMode(acceptedRuntime) };
      } else {
        this.state = { kind: "open", runtime: withoutCleanupSettlementMode(fallbackRuntime) };
      }
      throw error;
    }
    this.state =
      retryKind === "binding-pending"
        ? { kind: "binding-pending", mode, runtime: errorRuntime }
        : { kind: "binding-persistence-pending", mode, runtime: errorRuntime };
    if (isSettlementBindingPersistenceFailure(error)) throw error;
    throw new BrowserAutomationError(
      `Browser ${mode} authority could not be durably bound before cleanup.`,
      {
        stage: "browser-run-lifecycle",
        code: "browser-settlement-binding-persistence-failed",
        requestedMode: mode,
        runtime: errorRuntime,
      },
      error,
    );
  }

  private modeConflict(
    requestedMode: BrowserCaptureSettlementMode,
    boundMode: BrowserCaptureSettlementMode,
    phase: string,
    runtime: BrowserRuntimeMetadata,
  ): BrowserAutomationError {
    return (
      this.adapters.settlementModeConflict?.(requestedMode, boundMode, runtime, phase) ??
      settlementModeConflict(requestedMode, boundMode, phase)
    );
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
        if (isSettlementModeConflict(error)) {
          const conflictRuntime =
            error.details?.runtime &&
            typeof error.details.runtime === "object" &&
            !Array.isArray(error.details.runtime)
              ? (error.details.runtime as BrowserRuntimeMetadata)
              : runtime;
          const conflictMode =
            cleanupSettlementMode(conflictRuntime) ??
            (
              error.details?.settlementAuthority as
                | { mode?: BrowserCaptureSettlementMode }
                | undefined
            )?.mode ??
            mode;
          this.state = { kind: "bound", mode: conflictMode, runtime: conflictRuntime };
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
            if (this.adapters.ownerId) {
              await acknowledgeSettledTargetCloseCapabilities(
                boundRuntime,
                boundResult.runtime,
                this.adapters.ownerId,
              );
            }
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
          if (isSettlementModeConflict(error)) {
            const conflictRuntime =
              error.details?.runtime &&
              typeof error.details.runtime === "object" &&
              !Array.isArray(error.details.runtime)
                ? (error.details.runtime as BrowserRuntimeMetadata)
                : retryRuntime;
            const conflictMode =
              cleanupSettlementMode(conflictRuntime) ??
              (
                error.details?.settlementAuthority as
                  | { mode?: BrowserCaptureSettlementMode }
                  | undefined
              )?.mode ??
              mode;
            this.state = { kind: "bound", mode: conflictMode, runtime: conflictRuntime };
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
