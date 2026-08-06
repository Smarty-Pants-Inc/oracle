import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { ChromeLaunchResult, RetainedChromeEndpointAuthority } from "./chromeLifecycle.js";
import type { BrowserTabLease } from "./tabLeaseRegistry.js";
import type { BrowserCaptureFinalizationResult } from "./types.js";
import {
  OwnedBrowserResourceTransaction,
  type BrowserCaptureSettlementMode,
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
 * Canonical local target, lease, and process authority shared by every owned-browser feature lane.
 * The state owner projects durable authority; focused adapters execute acquisition and settlement
 * effects without owning a second resource representation.
 */
export class LocalOwnedBrowserResourceAuthority {
  private readonly state: LocalOwnedBrowserResourceStateOwner;
  private readonly settlement: LocalOwnedBrowserResourceSettlementAdapter;
  private readonly transaction: OwnedBrowserResourceTransaction;

  constructor(options: LocalOwnedBrowserResourceAuthorityOptions) {
    this.state = new LocalOwnedBrowserResourceStateOwner(options);
    this.settlement = new LocalOwnedBrowserResourceSettlementAdapter(this.state);
    this.transaction = new OwnedBrowserResourceTransaction(
      {
        ownerId: this.state.ownerId,
        ...(this.state.options.persistRuntime
          ? { persistRuntime: this.state.options.persistRuntime }
          : {}),
        ...(this.state.options.persistSettlementResult
          ? { persistSettlementResult: this.state.options.persistSettlementResult }
          : {}),
        settleResources: (mode, runtime) => this.settlement.settle(mode, runtime),
      },
      this.state.buildRuntime(),
    );
  }

  runtime(): BrowserRuntimeMetadata {
    return this.transaction.runtime();
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

  configureSettlementAdapters(adapters: LocalOwnedBrowserSettlementAdapters): void {
    this.settlement.configure(adapters);
  }

  journalAcquisition<T>(step: LocalOwnedBrowserAcquisitionStep<T>): Promise<T> {
    return journalLocalOwnedBrowserAcquisition(this.state, this.transaction, this.settlement, step);
  }

  async persistProjection(projection: LocalOwnedBrowserRuntimeProjection): Promise<void> {
    this.state.updateProjection(projection);
    await this.transaction.persist(this.state.buildRuntime());
  }

  closeTargetForRetry(): Promise<void> {
    return this.settlement.closeTargetForRetry();
  }

  disconnect(): Promise<void> {
    return this.settlement.disconnect();
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
      this.state.replaceAuthoritativeRuntime(authoritativeRuntime);
      this.transaction.replaceRuntime(this.state.buildRuntime());
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
        `${this.state.options.purpose} browser resource effects require durably bound ${mode} authority.`,
        {
          stage: "browser-run-lifecycle",
          code: "browser-resource-effects-before-settlement-binding",
          requestedMode: mode,
        },
      );
    }
    return this.settlement.settle(mode, pendingRuntime);
  }
}
