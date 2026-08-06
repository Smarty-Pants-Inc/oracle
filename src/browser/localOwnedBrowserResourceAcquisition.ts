import type { OwnedBrowserResourceTransaction } from "./ownedBrowserResourceTransaction.js";
import type {
  LocalOwnedBrowserAcquisitionStep,
  LocalOwnedBrowserResourceStateOwner,
} from "./localOwnedBrowserResourceState.js";

export interface LocalOwnedBrowserAcquisitionEffects {
  onProcessAcquired(): void;
  onTargetAcquired(): void;
}

export async function journalLocalOwnedBrowserAcquisition<T>(
  state: LocalOwnedBrowserResourceStateOwner,
  transaction: OwnedBrowserResourceTransaction,
  effects: LocalOwnedBrowserAcquisitionEffects,
  step: LocalOwnedBrowserAcquisitionStep<T>,
): Promise<T> {
  const alreadyPending = state.pendingResource;
  if (alreadyPending) {
    throw new Error(
      `Cannot acquire ${step.resource} while ${alreadyPending} acquisition is pending.`,
    );
  }
  state.beginAcquisition(step.resource);
  return await transaction.journalAcquisition({
    intentRuntime: state.buildRuntime(),
    acquire: async () => {
      state.markAcquisitionEffectStarted(step.resource);
      return await step.acquire();
    },
    acquiredRuntime: (resource) => {
      if (step.resource === "tab-lease") {
        state.acquireLease(step.authority(resource));
      } else if (step.resource === "chrome-process") {
        state.acquireProcess(step.authority(resource));
        effects.onProcessAcquired();
      } else {
        state.acquireTarget(step.authority(resource));
        effects.onTargetAcquired();
      }
      return state.buildRuntime();
    },
  });
}
