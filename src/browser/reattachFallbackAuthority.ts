import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import type { TemporaryProfileAuthority } from "../privateTempRoot.js";
import type { ChromeLaunchResult, RetainedChromeEndpointAuthority } from "./chromeLifecycle.js";
import { settleManualChromeOwner, type ManualChromeOwner } from "./manualChromeOwner.js";
import {
  LocalOwnedBrowserResourceAuthority,
  type BrowserCaptureSettlementMode,
  type LocalOwnedBrowserAcquisitionStep,
  type LocalOwnedBrowserProcessSettlement,
} from "./ownedBrowserResources.js";
import type { ChromeProcessLaunchClaim } from "./chromeProcessLaunchClaim.js";
import type { ChromeOwnerDisposition, ProfileDirectoryIdentity } from "./profileState.js";
import {
  finalizeRecoveredRuntime,
  type ReattachCleanupDeps,
  type ReattachFinalizationResult,
} from "./reattachCleanup.js";
import type { BrowserTabLease } from "./tabLeaseRegistry.js";
import type { BrowserLogger } from "./types.js";

export interface ReattachFallbackAuthorityOptions {
  ownerId: string;
  baseRuntime: BrowserRuntimeMetadata;
  userDataDir: string;
  profileIdentity: ProfileDirectoryIdentity;
  temporaryProfileAuthority?: TemporaryProfileAuthority;
  manualLogin: boolean;
  keepBrowser: boolean;
  generationId: string;
  launchClaim: ChromeProcessLaunchClaim;
  ownerDisposition: ChromeOwnerDisposition;
  leaseId: string;
  targetMarkerUrl: string;
  logger: BrowserLogger;
  runtimeHintCb?: (runtime: BrowserRuntimeMetadata) => void | Promise<void>;
  recoveryCleanup?: ReattachCleanupDeps;
}

export class ReattachFallbackAuthority {
  private readonly resources: LocalOwnedBrowserResourceAuthority;

  constructor(options: ReattachFallbackAuthorityOptions) {
    const ownerId = options.ownerId.trim();
    const generationId = options.generationId.trim();
    if (!ownerId || !generationId) {
      throw new Error("Reattach fallback authority requires an owner and acquisition generation.");
    }
    options = Object.freeze({
      ...options,
      ownerId,
      generationId,
      profileIdentity: Object.freeze({ ...options.profileIdentity }),
      launchClaim: Object.freeze({ ...options.launchClaim }),
      ...(options.recoveryCleanup
        ? { recoveryCleanup: Object.freeze({ ...options.recoveryCleanup }) }
        : {}),
    });
    const cleanup = options.recoveryCleanup;
    const releaseLease = cleanup?.releaseBrowserTabLease;
    const pendingProcess = (reason: string): LocalOwnedBrowserProcessSettlement => ({
      status: "pending",
      reason,
    });
    const settleManualProcess = async (
      owner: ManualChromeOwner,
    ): Promise<LocalOwnedBrowserProcessSettlement> => {
      try {
        const settlement = await (cleanup?.settleManualChromeOwner ?? settleManualChromeOwner)(
          options.userDataDir,
          owner,
          options.logger,
        );
        return settlement.status === "unsafe"
          ? pendingProcess(settlement.reason)
          : {
              status: "completed",
              disposition: settlement.status === "terminated" ? "terminated" : "preserved",
            };
      } catch (error) {
        return pendingProcess(
          `Canonical Chrome owner settlement failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    this.resources = new LocalOwnedBrowserResourceAuthority({
      ownerId: options.ownerId,
      purpose: "ChatGPT reattach fallback",
      targetLabel: "Owned fallback Chrome",
      baseRuntime: options.baseRuntime,
      userDataDir: options.userDataDir,
      profileDirectoryIdentity: options.profileIdentity,
      ...(options.temporaryProfileAuthority
        ? { temporaryProfileAuthority: options.temporaryProfileAuthority }
        : {}),
      profileKind: options.manualLogin ? "manual-login" : "temporary",
      keepBrowser: options.keepBrowser,
      closeOwnedTargetOnComplete: true,
      generationId: options.generationId,
      processOwnerProvenance: options.manualLogin ? "manual-canonical-owner" : "temporary-launch",
      processLaunchClaim: options.launchClaim,
      processOwnerDisposition: options.ownerDisposition,
      leaseId: options.leaseId,
      targetMarkerUrl: options.targetMarkerUrl,
      logger: options.logger,
      disconnectBeforeTarget: true,
      ...(releaseLease
        ? {
            releaseLease: (lease: BrowserTabLease, releaseOptions) =>
              releaseLease(options.userDataDir, lease, options.logger, releaseOptions),
          }
        : {}),
      settleManualProcess,
      ...(options.runtimeHintCb
        ? {
            persistRuntime: async (runtime) => await options.runtimeHintCb?.(runtime),
            persistSettlementResult: async (runtime) => {
              if (runtime.recoveryCleanupResources?.length || runtime.recoveryCleanupResult) {
                await options.runtimeHintCb?.(runtime);
              }
            },
          }
        : {}),
      settleRemainingResources: (mode, runtime) =>
        finalizeRecoveredRuntime(
          runtime,
          options.logger,
          { ...options.recoveryCleanup, ownerId: options.ownerId },
          mode,
        ),
    });
  }

  journalAcquisition<T>(step: LocalOwnedBrowserAcquisitionStep<T>): Promise<T> {
    return this.resources.journalAcquisition(step);
  }

  lease(): BrowserTabLease | null {
    return this.resources.acquiredLease();
  }

  acquiredChrome(): ChromeLaunchResult {
    return this.resources.acquiredChrome();
  }

  endpointAuthority(): RetainedChromeEndpointAuthority | undefined {
    return this.resources.endpointAuthority();
  }

  disconnectConnection(): Promise<void> {
    return this.resources.disconnect();
  }

  runtime(): BrowserRuntimeMetadata {
    return this.resources.runtime();
  }

  settle(mode: BrowserCaptureSettlementMode): Promise<ReattachFinalizationResult> {
    return this.resources.settle(mode);
  }
}
