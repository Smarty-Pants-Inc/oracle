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
import { closeChromeTargetWithRetainedCapability } from "./targetCloseAuthority.js";
import {
  acknowledgeSettledTargetCloseCapabilities,
  completedBrowserCaptureCleanup,
  OwnedBrowserResourceTransaction,
  pendingBrowserCaptureCleanup,
  type BrowserCaptureSettlementMode,
} from "./ownedBrowserResourceTransaction.js";

export type LocalOwnedBrowserPendingResource = "tab-lease" | "chrome-process" | "chrome-target";
type LocalOwnedBrowserResourceStatus<T> =
  | { readonly status: "unacquired" }
  | { readonly status: "pending"; readonly effectStarted: boolean }
  | { readonly status: "acquired"; readonly authority: T }
  | { readonly status: "settled"; readonly authority: T | null };

interface LocalOwnedBrowserResourceState {
  readonly lease: LocalOwnedBrowserResourceStatus<BrowserTabLease>;
  readonly process: LocalOwnedBrowserResourceStatus<LocalOwnedBrowserProcessAuthority>;
  readonly target: LocalOwnedBrowserResourceStatus<LocalOwnedBrowserTargetAuthority>;
}

interface LocalOwnedBrowserAuthorityChange {
  readonly lease?: "settled";
  readonly process?: "settled";
  readonly target?: "settled";
}

function resourceAuthority<T>(resource: LocalOwnedBrowserResourceStatus<T>): T | null {
  return resource.status === "acquired" || resource.status === "settled"
    ? resource.authority
    : null;
}

function requiresSettlement<T>(resource: LocalOwnedBrowserResourceStatus<T>): boolean {
  return resource.status === "pending" || resource.status === "acquired";
}

function settleResource<T>(
  resource: LocalOwnedBrowserResourceStatus<T>,
): LocalOwnedBrowserResourceStatus<T> {
  if (resource.status === "pending") return { status: "settled", authority: null };
  if (resource.status === "acquired") {
    return { status: "settled", authority: resource.authority };
  }
  if (resource.status === "settled") return resource;
  throw new Error("Cannot settle a local browser resource before acquisition begins.");
}

function advanceResourceAuthority(
  state: LocalOwnedBrowserResourceState,
  changes: LocalOwnedBrowserAuthorityChange,
): LocalOwnedBrowserResourceState {
  return {
    lease: changes.lease ? settleResource(state.lease) : state.lease,
    process: changes.process ? settleResource(state.process) : state.process,
    target: changes.target ? settleResource(state.target) : state.target,
  };
}

export type LocalOwnedBrowserProcessAuthority =
  | { kind: "manual"; owner: ManualChromeOwner }
  | { kind: "temporary"; chrome: ChromeLaunchResult };

export type LocalOwnedBrowserProcessSettlement =
  | { status: "completed"; disposition: "terminated" | "preserved" }
  | { status: "pending"; reason: string };

export interface LocalOwnedBrowserTargetAuthority {
  targetId: string;
  chromeHost?: string;
  chromePort?: number;
  browserWSEndpoint?: string;
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
export interface LocalOwnedBrowserRuntimeProjection {
  keepBrowser: boolean;
  closeOwnedTargetOnComplete: boolean;
  tabUrl?: string;
}

export interface LocalOwnedBrowserSettlementAdapters {
  beforeProcessSettlement?: (
    mode: BrowserCaptureSettlementMode,
    runtime: BrowserRuntimeMetadata,
  ) => Promise<void>;
  onActiveLeaseHandoff?: () => void;
  onLeaseSettled?: () => void;
}

export interface LocalOwnedBrowserResourceAuthorityOptions {
  ownerId: string;
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
  targetMarkerUrl?: string;
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
  private readonly ownerId: string;
  private readonly options: LocalOwnedBrowserResourceAuthorityOptions;
  private baseRuntime: BrowserRuntimeMetadata;
  private inheritedResources: BrowserRecoveryCleanupResourceMetadata[];
  private resources: LocalOwnedBrowserResourceState = {
    lease: { status: "unacquired" },
    process: { status: "unacquired" },
    target: { status: "unacquired" },
  };
  private leaseTeardownAuthority: BrowserTabLeaseTeardownAuthority | null = null;
  private leaseProcessSettlement: LocalOwnedBrowserProcessSettlement | null = null;
  private connectionDisconnected = false;
  private keepBrowserDisposition: boolean;
  private closeOwnedTargetOnComplete: boolean;
  private tabUrl: string | undefined;
  private settlementAdapters: LocalOwnedBrowserSettlementAdapters = {};
  private settlementMode: BrowserCaptureSettlementMode | undefined;

  constructor(options: LocalOwnedBrowserResourceAuthorityOptions) {
    this.ownerId = options.ownerId.trim();
    const generationId = options.generationId.trim();
    if (!this.ownerId) throw new Error("Local browser resource authority requires an owner id.");
    if (!generationId) {
      throw new Error("Local browser resource authority requires an acquisition generation.");
    }
    this.options = Object.freeze({
      ...options,
      ownerId: this.ownerId,
      generationId,
      profileDirectoryIdentity: Object.freeze({ ...options.profileDirectoryIdentity }),
      processLaunchClaim: Object.freeze({ ...options.processLaunchClaim }),
    });
    this.baseRuntime = this.options.baseRuntime ?? {};
    this.inheritedResources = [...(this.baseRuntime.recoveryCleanupResources ?? [])];
    this.keepBrowserDisposition = this.options.keepBrowser;
    this.closeOwnedTargetOnComplete = this.options.closeOwnedTargetOnComplete;
    this.tabUrl = this.options.tabUrl;
    this.transaction = new OwnedBrowserResourceTransaction(
      {
        ownerId: this.ownerId,
        ...(this.options.persistRuntime ? { persistRuntime: this.options.persistRuntime } : {}),
        ...(this.options.persistSettlementResult
          ? { persistSettlementResult: this.options.persistSettlementResult }
          : {}),
        settleResources: (mode, runtime) => this.settleResources(mode, runtime),
      },
      this.buildRuntime(),
    );
  }

  private get pendingResource(): LocalOwnedBrowserPendingResource | undefined {
    if (this.resources.lease.status === "pending") return "tab-lease";
    if (this.resources.process.status === "pending") return "chrome-process";
    if (this.resources.target.status === "pending") return "chrome-target";
    return undefined;
  }

  private get lease(): BrowserTabLease | null {
    return resourceAuthority(this.resources.lease);
  }

  private get process(): LocalOwnedBrowserProcessAuthority | null {
    return resourceAuthority(this.resources.process);
  }

  private get target(): LocalOwnedBrowserTargetAuthority | null {
    return resourceAuthority(this.resources.target);
  }

  private get targetSettled(): boolean {
    return this.resources.target.status === "settled";
  }

  private get leaseSettled(): boolean {
    return this.resources.lease.status === "settled";
  }

  private get processSettled(): boolean {
    return this.resources.process.status === "settled";
  }

  private get pendingAcquisitionEffectStarted(): boolean {
    return this.resources.target.status === "pending" && this.resources.target.effectStarted;
  }

  runtime(): BrowserRuntimeMetadata {
    return this.transaction.runtime();
  }

  acquiredLease(): BrowserTabLease | null {
    return this.resources.lease.status === "acquired" ? this.resources.lease.authority : null;
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

  ownerIdValue(): string {
    return this.ownerId;
  }

  generationId(): string {
    return this.options.generationId;
  }

  targetMarkerUrl(): string {
    if (!this.options.targetMarkerUrl) {
      throw new Error(`${this.options.purpose} target acquisition marker is unavailable.`);
    }
    return this.options.targetMarkerUrl;
  }

  projectRuntime(
    authoritativeRuntime: BrowserRuntimeMetadata,
    projection: LocalOwnedBrowserRuntimeProjection,
  ): BrowserRuntimeMetadata {
    this.baseRuntime = authoritativeRuntime;
    this.keepBrowserDisposition = projection.keepBrowser;
    this.closeOwnedTargetOnComplete = projection.closeOwnedTargetOnComplete;
    this.tabUrl = projection.tabUrl;
    return this.buildRuntime();
  }

  configureSettlementAdapters(adapters: LocalOwnedBrowserSettlementAdapters): void {
    this.settlementAdapters = adapters;
  }

  async journalAcquisition<T>(step: LocalOwnedBrowserAcquisitionStep<T>): Promise<T> {
    const alreadyPending = this.pendingResource;
    if (alreadyPending) {
      throw new Error(
        `Cannot acquire ${step.resource} while ${alreadyPending} acquisition is pending.`,
      );
    }
    if (step.resource === "tab-lease") {
      this.resources = {
        ...this.resources,
        lease: { status: "pending", effectStarted: false },
      };
    } else if (step.resource === "chrome-process") {
      this.resources = {
        ...this.resources,
        process: { status: "pending", effectStarted: false },
      };
    } else {
      this.resources = {
        ...this.resources,
        target: { status: "pending", effectStarted: false },
      };
    }
    return await this.transaction.journalAcquisition({
      intentRuntime: this.buildRuntime(),
      acquire: async () => {
        if (step.resource === "tab-lease") {
          this.resources = {
            ...this.resources,
            lease: { status: "pending", effectStarted: true },
          };
        } else if (step.resource === "chrome-process") {
          this.resources = {
            ...this.resources,
            process: { status: "pending", effectStarted: true },
          };
        } else {
          this.resources = {
            ...this.resources,
            target: { status: "pending", effectStarted: true },
          };
        }
        return await step.acquire();
      },
      acquiredRuntime: (resource) => {
        if (step.resource === "tab-lease") {
          this.resources = {
            ...this.resources,
            lease: { status: "acquired", authority: step.authority(resource) },
          };
        } else if (step.resource === "chrome-process") {
          this.resources = {
            ...this.resources,
            process: { status: "acquired", authority: step.authority(resource) },
          };
          this.leaseProcessSettlement = null;
          this.retainLeaseTeardownAuthority();
        } else {
          this.resources = {
            ...this.resources,
            target: { status: "acquired", authority: step.authority(resource) },
          };
          this.connectionDisconnected = false;
        }
        return this.buildRuntime();
      },
    });
  }

  async persistProjection(projection: LocalOwnedBrowserRuntimeProjection): Promise<void> {
    this.keepBrowserDisposition = projection.keepBrowser;
    this.closeOwnedTargetOnComplete = projection.closeOwnedTargetOnComplete;
    this.tabUrl = projection.tabUrl;
    await this.transaction.persist(this.buildRuntime());
  }

  async closeTargetForRetry(): Promise<void> {
    if (this.pendingResource !== "chrome-target" && (!this.target || this.targetSettled)) {
      return;
    }
    if (!this.target) {
      if (this.pendingAcquisitionEffectStarted) {
        throw new Error(
          `${this.options.targetLabel} target has no retained exact close capability`,
        );
      }
    } else {
      try {
        const closed = await closeChromeTargetWithRetainedCapability({
          ownerId: this.ownerId,
          capability: this.target.capability,
          targetId: this.target.targetId,
          logger: this.options.logger,
        });
        if (closed.status === "unsafe" || closed.status === "unavailable") {
          throw new Error(closed.reason);
        }
      } catch (error) {
        throw new Error(
          `${this.options.targetLabel} target close failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const error = await this.commitAuthorityChange({ target: "settled" });
    if (error) throw new Error(error);
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
      this.transaction.replaceRuntime(this.buildRuntime());
    }
    return this.transaction.settle(mode);
  }

  /**
   * Settle effects only after an enclosing publication transaction has durably bound the mode.
   * Acquisition rollback uses settle(); local run publication uses this path to avoid nesting two
   * persistence state machines around the same resource authority.
   */
  settleAfterDurableBinding(
    mode: BrowserCaptureSettlementMode,
    pendingRuntime: BrowserRuntimeMetadata,
  ): Promise<BrowserCaptureFinalizationResult> {
    if (pendingRuntime.recoveryCleanupResult?.settlementMode !== mode) {
      throw new BrowserAutomationError(
        `${this.options.purpose} browser resource effects require durably bound ${mode} authority.`,
        {
          stage: "browser-run-lifecycle",
          code: "browser-resource-effects-before-settlement-binding",
          requestedMode: mode,
        },
      );
    }
    return this.settleResources(mode, pendingRuntime);
  }

  private chrome(): ChromeLaunchResult | null {
    if (!this.process) return null;
    return this.process.kind === "manual" ? this.process.owner.chrome : this.process.chrome;
  }

  private keepBrowser(): boolean {
    return (
      this.keepBrowserDisposition ||
      (this.process?.kind === "manual" && this.process.owner.disposition === "preserve")
    );
  }

  private retainLeaseTeardownAuthority(): void {
    if (!this.lease || this.process?.kind !== "manual") return;
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

  private buildRuntime(
    mode = this.settlementMode,
    resourceState = this.resources,
  ): BrowserRuntimeMetadata {
    const lease = resourceAuthority(resourceState.lease);
    const processAuthority = resourceAuthority(resourceState.process);
    const target = resourceAuthority(resourceState.target);
    const pendingResource =
      resourceState.lease.status === "pending"
        ? "tab-lease"
        : resourceState.process.status === "pending"
          ? "chrome-process"
          : resourceState.target.status === "pending"
            ? "chrome-target"
            : undefined;
    const chrome = processAuthority
      ? processAuthority.kind === "manual"
        ? processAuthority.owner.chrome
        : processAuthority.chrome
      : null;
    const processIdentity = processAuthority
      ? processAuthority.kind === "manual"
        ? processAuthority.owner.processIdentity
        : processAuthority.chrome.processIdentity
      : undefined;
    const endpointAuthority =
      processAuthority?.kind === "manual"
        ? (processAuthority.owner.endpointAuthority ??
          processAuthority.owner.chrome.endpointAuthority)
        : processAuthority?.chrome.endpointAuthority;
    const processDisposition =
      processAuthority?.kind === "manual"
        ? processAuthority.owner.disposition
        : this.options.processOwnerDisposition;
    const keepBrowser =
      this.keepBrowserDisposition ||
      (processAuthority?.kind === "manual" && processAuthority.owner.disposition === "preserve");
    const targetPending = requiresSettlement(resourceState.target);
    const targetEndpoint =
      target && (targetPending || !this.closeOwnedTargetOnComplete) ? target : null;
    const leasePending = requiresSettlement(resourceState.lease);
    const processPending = requiresSettlement(resourceState.process);
    const ownsLocalResources = targetPending || leasePending || processPending;
    const next: BrowserRuntimeMetadata = {
      ...this.baseRuntime,
      browserTransport: "cdp",
      chromePid: chrome?.pid,
      chromeProcessIdentity: processIdentity,
      chromePort: targetEndpoint?.chromePort ?? chrome?.port,
      chromeHost: targetEndpoint?.chromeHost ?? chrome?.host ?? "127.0.0.1",
      chromeBrowserWSEndpoint:
        targetEndpoint?.browserWSEndpoint ?? endpointAuthority?.browserWSEndpoint,
      chromeProfileRoot: this.options.userDataDir,
      userDataDir: this.options.userDataDir,
      chromeTargetId: targetPending
        ? (target?.targetId ?? undefined)
        : target
          ? this.closeOwnedTargetOnComplete
            ? undefined
            : target.targetId
          : this.baseRuntime.chromeTargetId,
      ...(this.tabUrl ? { tabUrl: this.tabUrl } : {}),
      controllerPid: process.pid,
    };
    const resources = [...this.inheritedResources];
    if (ownsLocalResources) {
      resources.push({
        chromePid: chrome?.pid,
        chromeProcessIdentity: processIdentity,
        profileDirectoryIdentity:
          processIdentity?.profileDirectory ??
          lease?.profileDirectory ??
          this.options.profileDirectoryIdentity,
        chromePort: targetEndpoint?.chromePort ?? chrome?.port,
        chromeHost: targetEndpoint?.chromeHost ?? chrome?.host ?? "127.0.0.1",
        chromeBrowserWSEndpoint:
          targetEndpoint?.browserWSEndpoint ?? endpointAuthority?.browserWSEndpoint,
        chromeProfileRoot: this.options.userDataDir,
        userDataDir: this.options.userDataDir,
        chromeTargetId: targetPending
          ? (target?.targetId ?? undefined)
          : target
            ? this.closeOwnedTargetOnComplete
              ? undefined
              : target.targetId
            : this.baseRuntime.chromeTargetId,
        targetCloseCapability: targetPending ? target?.capability : undefined,
        conversationId: next.conversationId,
        promptEpoch: next.promptEpoch,
        tabLease: leasePending
          ? {
              generationId: lease?.generationId ?? this.options.generationId,
              id: lease?.id ?? this.options.leaseId ?? "",
              profileDirectory: lease?.profileDirectory ?? this.options.profileDirectoryIdentity,
            }
          : undefined,
        acquisition: {
          generationId: this.options.generationId,
          processOwnerProvenance: this.options.processOwnerProvenance,
          processLaunchClaim: this.options.processLaunchClaim,
          processOwnerDisposition: processDisposition,
          ...(pendingResource ? { pendingResource } : {}),
          ...(this.options.targetMarkerUrl
            ? { targetMarkerUrl: this.options.targetMarkerUrl }
            : {}),
        },
        recoveryCleanup: {
          ownsTarget: targetPending,
          profileKind: this.options.profileKind,
          keepBrowser,
          ...(targetPending ? { closeOwnedTargetOnComplete: this.closeOwnedTargetOnComplete } : {}),
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
      if (error) return pendingBrowserCaptureCleanup(this.buildRuntime(mode), error, mode);
    }

    if (this.pendingResource === "chrome-target" || (this.target && !this.targetSettled)) {
      const resource = pendingRuntime.recoveryCleanupResources?.find(
        (candidate) => candidate.acquisition?.generationId === this.options.generationId,
      );
      const closeTarget = resource?.recoveryCleanup.closeOwnedTargetOnComplete;
      if (typeof closeTarget !== "boolean") {
        return pendingBrowserCaptureCleanup(
          this.buildRuntime(mode),
          `${this.options.targetLabel} target ${mode} disposition is missing`,
          mode,
        );
      }
      if (closeTarget && !this.target) {
        if (!this.pendingAcquisitionEffectStarted) {
          const error = await this.commitAuthorityChange({ target: "settled" });
          if (error) return pendingBrowserCaptureCleanup(this.buildRuntime(mode), error, mode);
        } else if (this.process && !this.processSettled && !this.keepBrowser()) {
          deferredTargetToProcess = true;
        } else {
          if (this.options.settleRemainingResources) {
            return await this.settleUnretainedResources(mode);
          }
          return pendingBrowserCaptureCleanup(
            this.buildRuntime(mode),
            `${this.options.targetLabel} target has no retained exact close capability`,
            mode,
          );
        }
      } else {
        if (closeTarget && this.target) {
          try {
            const closed = await closeChromeTargetWithRetainedCapability({
              ownerId: this.ownerId,
              capability: this.target.capability,
              targetId: this.target.targetId,
              logger: this.options.logger,
            });
            if (closed.status === "unsafe" || closed.status === "unavailable") {
              if (this.process && !this.processSettled && !this.keepBrowser()) {
                deferredTargetToProcess = true;
              } else {
                return pendingBrowserCaptureCleanup(this.buildRuntime(mode), closed.reason, mode);
              }
            }
          } catch (error) {
            return pendingBrowserCaptureCleanup(
              this.buildRuntime(mode),
              `${this.options.targetLabel} target close failed: ${error instanceof Error ? error.message : String(error)}`,
              mode,
            );
          }
        }
        if (!deferredTargetToProcess) {
          const error = await this.commitAuthorityChange({ target: "settled" });
          if (error) return pendingBrowserCaptureCleanup(this.buildRuntime(mode), error, mode);
        }
      }
    }

    if (!this.options.disconnectBeforeTarget) {
      const error = await this.disconnectError();
      if (error) return pendingBrowserCaptureCleanup(this.buildRuntime(mode), error, mode);
    }

    if (this.leaseTeardownAuthority && this.process && !this.processSettled) {
      let processEffectAttempted = false;
      const outcome = await this.leaseTeardownAuthority.settle(async () => {
        processEffectAttempted = true;
        this.leaseProcessSettlement = await this.prepareAndSettleProcessEffect(mode);
        return this.leaseProcessSettlement.status === "completed";
      });
      const processSettlement = this.leaseProcessSettlement;
      if (outcome.status === "completed") {
        const processWasTerminated =
          processSettlement?.status === "completed" &&
          processSettlement.disposition === "terminated";
        const error = await this.commitAuthorityChange({
          lease: "settled",
          process: "settled",
          ...(deferredTargetToProcess && processWasTerminated
            ? { target: "settled" as const }
            : {}),
        });
        if (error) return pendingBrowserCaptureCleanup(this.buildRuntime(mode), error, mode);
        if (outcome.disposition === "active-lease-handoff") {
          this.settlementAdapters.onActiveLeaseHandoff?.();
        }
        if (deferredTargetToProcess && !processWasTerminated) {
          const preservationReason =
            outcome.disposition === "active-lease-handoff"
              ? "active-lease handoff"
              : "process preservation";
          return pendingBrowserCaptureCleanup(
            this.buildRuntime(mode),
            `${this.options.targetLabel} target has no retained exact close capability after ${preservationReason}`,
            mode,
          );
        }
      } else {
        if (this.leaseTeardownAuthority.leaseReleased && !this.leaseSettled) {
          const error = await this.commitAuthorityChange({ lease: "settled" });
          if (error) return pendingBrowserCaptureCleanup(this.buildRuntime(mode), error, mode);
        }
        return pendingBrowserCaptureCleanup(
          this.buildRuntime(mode),
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
              {
                id: this.options.leaseId,
                sessionId: this.ownerId,
                generationId: this.options.generationId,
                profileDirectory: this.options.profileDirectoryIdentity,
              },
              this.options.logger,
            );
          } else {
            throw new Error("lease id is missing");
          }
        } catch (error) {
          return pendingBrowserCaptureCleanup(
            this.buildRuntime(mode),
            `${this.options.purpose} browser lease release failed: ${error instanceof Error ? error.message : String(error)}`,
            mode,
          );
        }
        const error = await this.commitAuthorityChange({ lease: "settled" });
        if (error) return pendingBrowserCaptureCleanup(this.buildRuntime(mode), error, mode);
      }

      if (this.pendingResource === "chrome-process" && !this.process) {
        if (this.options.settleRemainingResources) {
          return await this.settleUnretainedResources(mode);
        }
        return pendingBrowserCaptureCleanup(
          this.buildRuntime(mode),
          `${this.options.purpose} Chrome process acquisition has no exact live owner authority`,
          mode,
        );
      }
      if (this.process && !this.processSettled) {
        const processSettlement = await this.prepareAndSettleProcessEffect(mode);
        if (processSettlement.status === "pending") {
          return pendingBrowserCaptureCleanup(
            this.buildRuntime(mode),
            processSettlement.reason,
            mode,
          );
        }
        const processWasTerminated = processSettlement.disposition === "terminated";
        const error = await this.commitAuthorityChange({
          process: "settled",
          ...(deferredTargetToProcess && processWasTerminated
            ? { target: "settled" as const }
            : {}),
        });
        if (error) return pendingBrowserCaptureCleanup(this.buildRuntime(mode), error, mode);
        if (deferredTargetToProcess && !processWasTerminated) {
          return pendingBrowserCaptureCleanup(
            this.buildRuntime(mode),
            `${this.options.targetLabel} target has no retained exact close capability after process preservation`,
            mode,
          );
        }
      }
    }

    const ownedRuntime = this.buildRuntime(mode);
    if (this.inheritedResources.length > 0 && this.options.settleRemainingResources) {
      const result = await this.options.settleRemainingResources(mode, ownedRuntime);
      this.baseRuntime = result.runtime;
      this.inheritedResources = [...(result.runtime.recoveryCleanupResources ?? [])];
      return result;
    }
    return completedBrowserCaptureCleanup(ownedRuntime);
  }

  private async settleUnretainedResources(
    mode: BrowserCaptureSettlementMode,
  ): Promise<BrowserCaptureFinalizationResult> {
    const result = await this.options.settleRemainingResources!(mode, this.buildRuntime(mode));
    this.baseRuntime = result.runtime;
    return result;
  }

  private async prepareAndSettleProcessEffect(
    mode: BrowserCaptureSettlementMode,
  ): Promise<LocalOwnedBrowserProcessSettlement> {
    try {
      await this.settlementAdapters.beforeProcessSettlement?.(mode, this.buildRuntime(mode));
    } catch (error) {
      return {
        status: "pending",
        reason: `Browser process settlement preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return await this.settleProcessEffect();
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
      let processSettlement: LocalOwnedBrowserProcessSettlement;
      if (this.options.settleManualProcess) {
        processSettlement = await this.options.settleManualProcess(this.process.owner);
      } else if (this.keepBrowser() && this.process.owner.disposition === "close-on-last-lease") {
        try {
          await releaseManualChromeOwnerEndpointAuthority(this.process.owner);
          processSettlement = { status: "completed", disposition: "preserved" };
        } catch (error) {
          processSettlement = {
            status: "pending",
            reason: `Exact Chrome endpoint release failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      } else {
        const settlement = await settleManualChromeOwner(
          this.options.userDataDir,
          this.process.owner,
          this.options.logger,
        );
        processSettlement =
          settlement.status === "unsafe"
            ? {
                status: "pending",
                reason: this.options.manualProcessErrorPrefix
                  ? `${this.options.manualProcessErrorPrefix}: ${settlement.reason}`
                  : settlement.reason,
              }
            : {
                status: "completed",
                disposition: settlement.status === "terminated" ? "terminated" : "preserved",
              };
      }
      if (
        processSettlement.status === "completed" &&
        processSettlement.disposition === "preserved"
      ) {
        try {
          this.process.owner.chrome.process?.unref?.();
        } catch {
          // Best effort only; retained process ownership is already explicit in runtime metadata.
        }
      }
      return processSettlement;
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

  private async commitAuthorityChange(
    changes: LocalOwnedBrowserAuthorityChange,
  ): Promise<string | null> {
    const beforeState = this.resources;
    const afterState = advanceResourceAuthority(beforeState, changes);
    const before = this.buildRuntime(this.settlementMode, beforeState);
    const after = this.buildRuntime(this.settlementMode, afterState);
    const terminalResultWillBePersisted =
      !after.recoveryCleanupResources?.length && Boolean(this.options.persistSettlementResult);
    try {
      if (!terminalResultWillBePersisted) {
        await this.options.persistRuntime?.(after);
        await acknowledgeSettledTargetCloseCapabilities(before, after, this.ownerId);
      }
    } catch (error) {
      return `Browser authority progress could not be persisted: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.resources = afterState;
    if (changes.lease && beforeState.lease.status !== "settled") {
      this.settlementAdapters.onLeaseSettled?.();
    }
    return null;
  }
}
