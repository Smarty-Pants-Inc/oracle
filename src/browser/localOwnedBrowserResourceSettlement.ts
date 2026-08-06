import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import {
  acknowledgeSettledTargetCloseCapabilities,
  completedBrowserCaptureCleanup,
  pendingBrowserCaptureCleanup,
  type BrowserCaptureSettlementMode,
} from "./ownedBrowserResourceTransaction.js";
import {
  releaseBrowserTabLease,
  type BrowserTabLeaseTeardownAuthority,
} from "./tabLeaseRegistry.js";
import type { BrowserCaptureFinalizationResult } from "./types.js";
import { closeChromeTargetWithRetainedCapability } from "./targetCloseAuthority.js";
import {
  retainLocalOwnedBrowserLeaseTeardownAuthority,
  settleLocalOwnedBrowserProcess,
} from "./localOwnedBrowserProcessPolicy.js";
import type {
  LocalOwnedBrowserAuthorityChange,
  LocalOwnedBrowserProcessSettlement,
  LocalOwnedBrowserSettlementAdapters,
} from "./localOwnedBrowserResourceState.js";
import { LocalOwnedBrowserResourceStateOwner } from "./localOwnedBrowserResourceState.js";

export class LocalOwnedBrowserResourceSettlementAdapter {
  private leaseTeardownAuthority: BrowserTabLeaseTeardownAuthority | null = null;
  private leaseProcessSettlement: LocalOwnedBrowserProcessSettlement | null = null;
  private connectionDisconnected = false;
  private adapters: LocalOwnedBrowserSettlementAdapters = {};

  constructor(private readonly state: LocalOwnedBrowserResourceStateOwner) {}

  configure(adapters: LocalOwnedBrowserSettlementAdapters): void {
    this.adapters = adapters;
  }

  onProcessAcquired(): void {
    this.leaseProcessSettlement = null;
    this.leaseTeardownAuthority = retainLocalOwnedBrowserLeaseTeardownAuthority(
      this.state.lease,
      this.state.process,
      this.state.options,
    );
  }

  onTargetAcquired(): void {
    this.connectionDisconnected = false;
  }

  async closeTargetForRetry(): Promise<void> {
    if (
      this.state.pendingResource !== "chrome-target" &&
      (!this.state.target || this.state.targetSettled)
    ) {
      return;
    }
    if (!this.state.target) {
      if (this.state.pendingTargetEffectStarted) {
        throw new Error(
          `${this.state.options.targetLabel} target has no retained exact close capability`,
        );
      }
    } else {
      try {
        const closed = await closeChromeTargetWithRetainedCapability({
          ownerId: this.state.ownerId,
          capability: this.state.target.capability,
          targetId: this.state.target.targetId,
          logger: this.state.options.logger,
        });
        if (closed.status === "unsafe" || closed.status === "unavailable") {
          throw new Error(closed.reason);
        }
      } catch (error) {
        throw new Error(
          `${this.state.options.targetLabel} target close failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const error = await this.commitAuthorityChange({ target: "settled" });
    if (error) throw new Error(error);
  }

  async disconnect(): Promise<void> {
    if (this.connectionDisconnected || !this.state.target?.disconnect) return;
    try {
      await this.state.target.disconnect();
      this.connectionDisconnected = true;
    } catch (error) {
      if (this.state.options.disconnectErrorPrefix) {
        throw new Error(
          `${this.state.options.disconnectErrorPrefix}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.connectionDisconnected = true;
    }
  }

  async settle(
    mode: BrowserCaptureSettlementMode,
    pendingRuntime: BrowserRuntimeMetadata,
  ): Promise<BrowserCaptureFinalizationResult> {
    this.state.bindSettlement(mode, pendingRuntime);
    let deferredTargetToProcess = false;

    if (this.state.options.disconnectBeforeTarget) {
      const error = await this.disconnectError();
      if (error) return pendingBrowserCaptureCleanup(this.state.buildRuntime(mode), error, mode);
    }

    if (
      this.state.pendingResource === "chrome-target" ||
      (this.state.target && !this.state.targetSettled)
    ) {
      const resource = pendingRuntime.recoveryCleanupResources?.find(
        (candidate) => candidate.acquisition?.generationId === this.state.options.generationId,
      );
      const closeTarget = resource?.recoveryCleanup.closeOwnedTargetOnComplete;
      if (typeof closeTarget !== "boolean") {
        return pendingBrowserCaptureCleanup(
          this.state.buildRuntime(mode),
          `${this.state.options.targetLabel} target ${mode} disposition is missing`,
          mode,
        );
      }
      if (closeTarget && !this.state.target) {
        if (!this.state.pendingTargetEffectStarted) {
          const error = await this.commitAuthorityChange({ target: "settled" });
          if (error) {
            return pendingBrowserCaptureCleanup(this.state.buildRuntime(mode), error, mode);
          }
        } else if (this.state.process && !this.state.processSettled && !this.state.keepsBrowser()) {
          deferredTargetToProcess = true;
        } else {
          if (this.state.options.settleRemainingResources) {
            return await this.settleUnretainedResources(mode);
          }
          return pendingBrowserCaptureCleanup(
            this.state.buildRuntime(mode),
            `${this.state.options.targetLabel} target has no retained exact close capability`,
            mode,
          );
        }
      } else {
        if (closeTarget && this.state.target) {
          try {
            const closed = await closeChromeTargetWithRetainedCapability({
              ownerId: this.state.ownerId,
              capability: this.state.target.capability,
              targetId: this.state.target.targetId,
              logger: this.state.options.logger,
            });
            if (closed.status === "unsafe" || closed.status === "unavailable") {
              if (this.state.process && !this.state.processSettled && !this.state.keepsBrowser()) {
                deferredTargetToProcess = true;
              } else {
                return pendingBrowserCaptureCleanup(
                  this.state.buildRuntime(mode),
                  closed.reason,
                  mode,
                );
              }
            }
          } catch (error) {
            return pendingBrowserCaptureCleanup(
              this.state.buildRuntime(mode),
              `${this.state.options.targetLabel} target close failed: ${error instanceof Error ? error.message : String(error)}`,
              mode,
            );
          }
        }
        if (!deferredTargetToProcess) {
          const error = await this.commitAuthorityChange({ target: "settled" });
          if (error) {
            return pendingBrowserCaptureCleanup(this.state.buildRuntime(mode), error, mode);
          }
        }
      }
    }

    if (!this.state.options.disconnectBeforeTarget) {
      const error = await this.disconnectError();
      if (error) return pendingBrowserCaptureCleanup(this.state.buildRuntime(mode), error, mode);
    }

    if (this.leaseTeardownAuthority && this.state.process && !this.state.processSettled) {
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
        if (error) return pendingBrowserCaptureCleanup(this.state.buildRuntime(mode), error, mode);
        if (outcome.disposition === "active-lease-handoff") {
          this.adapters.onActiveLeaseHandoff?.();
        }
        if (deferredTargetToProcess && !processWasTerminated) {
          const preservationReason =
            outcome.disposition === "active-lease-handoff"
              ? "active-lease handoff"
              : "process preservation";
          return pendingBrowserCaptureCleanup(
            this.state.buildRuntime(mode),
            `${this.state.options.targetLabel} target has no retained exact close capability after ${preservationReason}`,
            mode,
          );
        }
      } else {
        if (this.leaseTeardownAuthority.leaseReleased && !this.state.leaseSettled) {
          const error = await this.commitAuthorityChange({ lease: "settled" });
          if (error) {
            return pendingBrowserCaptureCleanup(this.state.buildRuntime(mode), error, mode);
          }
        }
        return pendingBrowserCaptureCleanup(
          this.state.buildRuntime(mode),
          processEffectAttempted && processSettlement?.status === "pending"
            ? processSettlement.reason
            : (outcome.error ?? outcome.reason),
          mode,
        );
      }
    } else {
      if (
        this.state.pendingResource === "tab-lease" ||
        (this.state.lease && !this.state.leaseSettled)
      ) {
        try {
          if (this.state.lease) {
            if (this.state.options.releaseLease) {
              await this.state.options.releaseLease(this.state.lease);
            } else {
              await this.state.lease.release();
            }
          } else if (this.state.options.leaseId) {
            await releaseBrowserTabLease(
              this.state.options.userDataDir,
              {
                id: this.state.options.leaseId,
                sessionId: this.state.ownerId,
                generationId: this.state.options.generationId,
                profileDirectory: this.state.options.profileDirectoryIdentity,
              },
              this.state.options.logger,
            );
          } else {
            throw new Error("lease id is missing");
          }
        } catch (error) {
          return pendingBrowserCaptureCleanup(
            this.state.buildRuntime(mode),
            `${this.state.options.purpose} browser lease release failed: ${error instanceof Error ? error.message : String(error)}`,
            mode,
          );
        }
        const error = await this.commitAuthorityChange({ lease: "settled" });
        if (error) return pendingBrowserCaptureCleanup(this.state.buildRuntime(mode), error, mode);
      }

      if (this.state.pendingResource === "chrome-process" && !this.state.process) {
        if (this.state.options.settleRemainingResources) {
          return await this.settleUnretainedResources(mode);
        }
        return pendingBrowserCaptureCleanup(
          this.state.buildRuntime(mode),
          `${this.state.options.purpose} Chrome process acquisition has no exact live owner authority`,
          mode,
        );
      }
      if (this.state.process && !this.state.processSettled) {
        const processSettlement = await this.prepareAndSettleProcessEffect(mode);
        if (processSettlement.status === "pending") {
          return pendingBrowserCaptureCleanup(
            this.state.buildRuntime(mode),
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
        if (error) return pendingBrowserCaptureCleanup(this.state.buildRuntime(mode), error, mode);
        if (deferredTargetToProcess && !processWasTerminated) {
          return pendingBrowserCaptureCleanup(
            this.state.buildRuntime(mode),
            `${this.state.options.targetLabel} target has no retained exact close capability after process preservation`,
            mode,
          );
        }
      }
    }

    const ownedRuntime = this.state.buildRuntime(mode);
    if (this.state.hasInheritedResources && this.state.options.settleRemainingResources) {
      const result = await this.state.options.settleRemainingResources(mode, ownedRuntime);
      this.state.acceptRemainingSettlement(result);
      return result;
    }
    return completedBrowserCaptureCleanup(ownedRuntime);
  }

  private async settleUnretainedResources(
    mode: BrowserCaptureSettlementMode,
  ): Promise<BrowserCaptureFinalizationResult> {
    const result = await this.state.options.settleRemainingResources!(
      mode,
      this.state.buildRuntime(mode),
    );
    this.state.replaceAuthoritativeRuntime(result.runtime);
    return result;
  }

  private async prepareAndSettleProcessEffect(
    mode: BrowserCaptureSettlementMode,
  ): Promise<LocalOwnedBrowserProcessSettlement> {
    try {
      await this.adapters.beforeProcessSettlement?.(mode, this.state.buildRuntime(mode));
    } catch (error) {
      return {
        status: "pending",
        reason: `Browser process settlement preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return await settleLocalOwnedBrowserProcess({
      process: this.state.process,
      target: this.state.target,
      keepBrowser: this.state.keepsBrowser(),
      userDataDir: this.state.options.userDataDir,
      logger: this.state.options.logger,
      ...(this.state.options.manualProcessErrorPrefix
        ? { manualProcessErrorPrefix: this.state.options.manualProcessErrorPrefix }
        : {}),
      ...(this.state.options.settleManualProcess
        ? { settleManualProcess: this.state.options.settleManualProcess }
        : {}),
      ...(this.state.options.settleTemporaryProcess
        ? { settleTemporaryProcess: this.state.options.settleTemporaryProcess }
        : {}),
    });
  }

  private async disconnectError(): Promise<string | null> {
    try {
      await this.disconnect();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private async commitAuthorityChange(
    changes: LocalOwnedBrowserAuthorityChange,
  ): Promise<string | null> {
    const transition = this.state.prepareAuthorityChange(changes);
    const terminalResultWillBePersisted =
      !transition.after.recoveryCleanupResources?.length &&
      Boolean(this.state.options.persistSettlementResult);
    try {
      if (!terminalResultWillBePersisted) {
        await this.state.options.persistRuntime?.(transition.after);
        await acknowledgeSettledTargetCloseCapabilities(
          transition.before,
          transition.after,
          this.state.ownerId,
        );
      }
    } catch (error) {
      return `Browser authority progress could not be persisted: ${error instanceof Error ? error.message : String(error)}`;
    }
    transition.commit();
    if (transition.leaseChanged) this.adapters.onLeaseSettled?.();
    return null;
  }
}
