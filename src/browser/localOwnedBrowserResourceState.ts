import type {
  BrowserProcessAcquisitionProvenance,
  BrowserRecoveryCleanupResourceMetadata,
  BrowserRecoveryProfileKind,
  BrowserRecoveryTargetCloseCapabilityMetadata,
  BrowserRuntimeMetadata,
} from "../sessionManager.js";
import type { ChromeLaunchResult, RetainedChromeEndpointAuthority } from "./chromeLifecycle.js";
import type { ChromeProcessLaunchClaim } from "./chromeProcessLaunchClaim.js";
import type { ManualChromeOwner } from "./manualChromeOwner.js";
import type { ChromeOwnerDisposition, ProfileDirectoryIdentity } from "./profileState.js";
import type { BrowserTabLease, BrowserTabLeaseReleaseOptions } from "./tabLeaseRegistry.js";
import type { BrowserCaptureFinalizationResult, BrowserLogger } from "./types.js";
import type { BrowserCaptureSettlementMode } from "./ownedBrowserResourceTransaction.js";

export type LocalOwnedBrowserPendingResource = "tab-lease" | "chrome-process" | "chrome-target";

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

export interface LocalOwnedBrowserAuthorityChange {
  readonly lease?: "settled";
  readonly process?: "settled";
  readonly target?: "settled";
}

export interface LocalOwnedBrowserPreparedAuthorityChange {
  readonly before: BrowserRuntimeMetadata;
  readonly after: BrowserRuntimeMetadata;
  readonly leaseChanged: boolean;
  commit(): void;
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

/** Sole mutable owner of local resource status and its durable runtime projection. */
export class LocalOwnedBrowserResourceStateOwner {
  readonly ownerId: string;
  readonly options: Readonly<LocalOwnedBrowserResourceAuthorityOptions>;

  private baseRuntime: BrowserRuntimeMetadata;
  private inheritedResources: BrowserRecoveryCleanupResourceMetadata[];
  private resources: LocalOwnedBrowserResourceState = {
    lease: { status: "unacquired" },
    process: { status: "unacquired" },
    target: { status: "unacquired" },
  };
  private keepBrowserDisposition: boolean;
  private closeOwnedTargetOnComplete: boolean;
  private tabUrl: string | undefined;
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
  }

  get pendingResource(): LocalOwnedBrowserPendingResource | undefined {
    if (this.resources.lease.status === "pending") return "tab-lease";
    if (this.resources.process.status === "pending") return "chrome-process";
    if (this.resources.target.status === "pending") return "chrome-target";
    return undefined;
  }

  get lease(): BrowserTabLease | null {
    return resourceAuthority(this.resources.lease);
  }

  get process(): LocalOwnedBrowserProcessAuthority | null {
    return resourceAuthority(this.resources.process);
  }

  get target(): LocalOwnedBrowserTargetAuthority | null {
    return resourceAuthority(this.resources.target);
  }

  get targetSettled(): boolean {
    return this.resources.target.status === "settled";
  }

  get leaseSettled(): boolean {
    return this.resources.lease.status === "settled";
  }

  get processSettled(): boolean {
    return this.resources.process.status === "settled";
  }

  get pendingTargetEffectStarted(): boolean {
    return this.resources.target.status === "pending" && this.resources.target.effectStarted;
  }

  get hasInheritedResources(): boolean {
    return this.inheritedResources.length > 0;
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

  targetMarkerUrl(): string {
    if (!this.options.targetMarkerUrl) {
      throw new Error(`${this.options.purpose} target acquisition marker is unavailable.`);
    }
    return this.options.targetMarkerUrl;
  }

  keepsBrowser(): boolean {
    return (
      this.keepBrowserDisposition ||
      (this.process?.kind === "manual" && this.process.owner.disposition === "preserve")
    );
  }

  projectRuntime(
    authoritativeRuntime: BrowserRuntimeMetadata,
    projection: LocalOwnedBrowserRuntimeProjection,
  ): BrowserRuntimeMetadata {
    this.baseRuntime = authoritativeRuntime;
    this.updateProjection(projection);
    return this.buildRuntime();
  }

  updateProjection(projection: LocalOwnedBrowserRuntimeProjection): void {
    this.keepBrowserDisposition = projection.keepBrowser;
    this.closeOwnedTargetOnComplete = projection.closeOwnedTargetOnComplete;
    this.tabUrl = projection.tabUrl;
  }

  bindSettlement(mode: BrowserCaptureSettlementMode, pendingRuntime: BrowserRuntimeMetadata): void {
    this.settlementMode = mode;
    this.baseRuntime = pendingRuntime;
  }

  replaceAuthoritativeRuntime(runtime: BrowserRuntimeMetadata): void {
    this.baseRuntime = runtime;
  }

  acceptRemainingSettlement(result: BrowserCaptureFinalizationResult): void {
    this.baseRuntime = result.runtime;
    this.inheritedResources = [...(result.runtime.recoveryCleanupResources ?? [])];
  }

  beginAcquisition(resource: LocalOwnedBrowserPendingResource): void {
    if (resource === "tab-lease") {
      this.resources = { ...this.resources, lease: { status: "pending", effectStarted: false } };
    } else if (resource === "chrome-process") {
      this.resources = { ...this.resources, process: { status: "pending", effectStarted: false } };
    } else {
      this.resources = { ...this.resources, target: { status: "pending", effectStarted: false } };
    }
  }

  markAcquisitionEffectStarted(resource: LocalOwnedBrowserPendingResource): void {
    if (resource === "tab-lease") {
      this.resources = { ...this.resources, lease: { status: "pending", effectStarted: true } };
    } else if (resource === "chrome-process") {
      this.resources = { ...this.resources, process: { status: "pending", effectStarted: true } };
    } else {
      this.resources = { ...this.resources, target: { status: "pending", effectStarted: true } };
    }
  }

  acquireLease(lease: BrowserTabLease): void {
    this.resources = { ...this.resources, lease: { status: "acquired", authority: lease } };
  }

  acquireProcess(process: LocalOwnedBrowserProcessAuthority): void {
    this.resources = { ...this.resources, process: { status: "acquired", authority: process } };
  }

  acquireTarget(target: LocalOwnedBrowserTargetAuthority): void {
    this.resources = { ...this.resources, target: { status: "acquired", authority: target } };
  }

  prepareAuthorityChange(
    changes: LocalOwnedBrowserAuthorityChange,
  ): LocalOwnedBrowserPreparedAuthorityChange {
    const beforeState = this.resources;
    const afterState = advanceResourceAuthority(beforeState, changes);
    return {
      before: this.buildRuntime(this.settlementMode, beforeState),
      after: this.buildRuntime(this.settlementMode, afterState),
      leaseChanged: Boolean(changes.lease && beforeState.lease.status !== "settled"),
      commit: () => {
        if (this.resources !== beforeState) {
          throw new Error("Local browser resource authority changed during persistence.");
        }
        this.resources = afterState;
      },
    };
  }

  buildRuntime(mode = this.settlementMode, resourceState = this.resources): BrowserRuntimeMetadata {
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

  private chrome(): ChromeLaunchResult | null {
    if (!this.process) return null;
    return this.process.kind === "manual" ? this.process.owner.chrome : this.process.chrome;
  }
}
