import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import type { ChromeLaunchResult, RetainedChromeEndpointAuthority } from "./chromeLifecycle.js";
import type { BrowserTabLease } from "./tabLeaseRegistry.js";
import type { BrowserCaptureFinalizationResult } from "./types.js";
import type {
  BrowserCaptureSettlementMode,
  OwnedBrowserResourceTransaction,
  OwnedBrowserResourceTransactionAdapters,
} from "./ownedBrowserResourceTransaction.js";
import { journalLocalOwnedBrowserAcquisition } from "./localOwnedBrowserResourceAcquisition.js";
import { LocalOwnedBrowserResourceSettlementAdapter } from "./localOwnedBrowserResourceSettlement.js";
import {
  LocalOwnedBrowserResourceStateOwner,
  type LocalOwnedBrowserAcquisitionStep,
  type LocalOwnedBrowserResourceAuthorityOptions,
  type LocalOwnedBrowserRuntimeProjection,
  type LocalOwnedBrowserSettlementAdapters,
} from "./localOwnedBrowserResourceState.js";

export type {
  LocalOwnedBrowserAcquisitionStep,
  LocalOwnedBrowserPendingResource,
  LocalOwnedBrowserProcessAuthority,
  LocalOwnedBrowserProcessSettlement,
  LocalOwnedBrowserResourceAuthorityOptions,
  LocalOwnedBrowserRuntimeProjection,
  LocalOwnedBrowserSettlementAdapters,
  LocalOwnedBrowserTargetAuthority,
} from "./localOwnedBrowserResourceState.js";

/**
 * Local target, lease, and process runtime/effect adapter. It owns live resource handles and their
 * projection, while OwnedBrowserResourceTransaction exclusively owns transition and retry state.
 */
export class LocalOwnedBrowserResourceAuthority {
  private readonly state: LocalOwnedBrowserResourceStateOwner;
  private readonly settlement: LocalOwnedBrowserResourceSettlementAdapter;

  private projectSettlementRuntime:
    | ((
        mode: BrowserCaptureSettlementMode,
        runtime: BrowserRuntimeMetadata,
      ) => BrowserRuntimeMetadata)
    | undefined;

  constructor(options: LocalOwnedBrowserResourceAuthorityOptions) {
    this.state = new LocalOwnedBrowserResourceStateOwner(options);
    this.settlement = new LocalOwnedBrowserResourceSettlementAdapter(this.state);
  }

  runtime(): BrowserRuntimeMetadata {
    return this.state.buildRuntime();
  }

  acquiredLease(): BrowserTabLease | null {
    return this.state.acquiredLease();
  }

  acquiredChrome(): ChromeLaunchResult {
    return this.state.acquiredChrome();
  }

  endpointAuthority(): RetainedChromeEndpointAuthority | undefined {
    return this.state.endpointAuthority();
  }

  ownerIdValue(): string {
    return this.state.ownerId;
  }

  generationId(): string {
    return this.state.options.generationId;
  }

  targetMarkerUrl(): string {
    return this.state.targetMarkerUrl();
  }

  projectRuntime(
    authoritativeRuntime: BrowserRuntimeMetadata,
    projection: LocalOwnedBrowserRuntimeProjection,
  ): BrowserRuntimeMetadata {
    return this.state.projectRuntime(authoritativeRuntime, projection);
  }

  configureSettlementAdapters(
    adapters: LocalOwnedBrowserSettlementAdapters,
    projectSettlementRuntime?: (
      mode: BrowserCaptureSettlementMode,
      runtime: BrowserRuntimeMetadata,
    ) => BrowserRuntimeMetadata,
  ): void {
    this.settlement.configure(adapters);
    this.projectSettlementRuntime = projectSettlementRuntime;
  }

  transactionAdapters(): OwnedBrowserResourceTransactionAdapters {
    return {
      ownerId: this.state.ownerId,
      ...(this.state.options.persistRuntime
        ? { persistRuntime: this.state.options.persistRuntime }
        : {}),
      ...(this.state.options.persistSettlementResult
        ? { persistSettlementResult: this.state.options.persistSettlementResult }
        : {}),
      projectSettlementRuntime: (mode, runtime) =>
        this.projectSettlementRuntime?.(mode, runtime) ?? runtime,
      settleResources: (mode, runtime) => this.settlement.settle(mode, runtime),
    };
  }

  journalAcquisition<T>(
    transaction: OwnedBrowserResourceTransaction,
    step: LocalOwnedBrowserAcquisitionStep<T>,
  ): Promise<T> {
    return journalLocalOwnedBrowserAcquisition(this.state, transaction, this.settlement, step);
  }

  async persistProjection(
    transaction: OwnedBrowserResourceTransaction,
    projection: LocalOwnedBrowserRuntimeProjection,
  ): Promise<void> {
    this.state.updateProjection(projection);
    await transaction.persist(this.state.buildRuntime());
  }

  closeTargetForRetry(): Promise<void> {
    return this.settlement.closeTargetForRetry();
  }

  disconnect(): Promise<void> {
    return this.settlement.disconnect();
  }

  settleResources(
    mode: BrowserCaptureSettlementMode,
    pendingRuntime: BrowserRuntimeMetadata,
  ): Promise<BrowserCaptureFinalizationResult> {
    return this.settlement.settle(mode, pendingRuntime);
  }
}
