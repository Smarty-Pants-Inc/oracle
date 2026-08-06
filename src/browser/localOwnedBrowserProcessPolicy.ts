import {
  releaseManualChromeOwnerEndpointAuthority,
  settleManualChromeOwner,
} from "./manualChromeOwner.js";
import {
  isSafeChromeTerminationOutcome,
  removeProfileDirectoryIfIdentityMatches,
} from "./profileState.js";
import {
  retainBrowserTabLeaseTeardownAuthority,
  type BrowserTabLease,
  type BrowserTabLeaseReleaseOptions,
  type BrowserTabLeaseTeardownAuthority,
} from "./tabLeaseRegistry.js";
import type { BrowserLogger } from "./types.js";
import type {
  LocalOwnedBrowserProcessAuthority,
  LocalOwnedBrowserProcessSettlement,
  LocalOwnedBrowserTargetAuthority,
} from "./localOwnedBrowserResourceState.js";

interface LocalOwnedBrowserLeasePolicyOptions {
  userDataDir: string;
  logger: BrowserLogger;
  releaseLease?: (lease: BrowserTabLease, options?: BrowserTabLeaseReleaseOptions) => Promise<void>;
}

export function retainLocalOwnedBrowserLeaseTeardownAuthority(
  lease: BrowserTabLease | null,
  process: LocalOwnedBrowserProcessAuthority | null,
  options: LocalOwnedBrowserLeasePolicyOptions,
): BrowserTabLeaseTeardownAuthority | null {
  if (!lease || process?.kind !== "manual") return null;
  const owner = process.owner;
  const onActiveLeaseHandoff = () => releaseManualChromeOwnerEndpointAuthority(owner);
  const releaseLease = options.releaseLease;
  if (!releaseLease) {
    return retainBrowserTabLeaseTeardownAuthority(options.userDataDir, lease, {
      logger: options.logger,
      onActiveLeaseHandoff,
    });
  }

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
        await releaseLease(lease, {
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

export interface LocalOwnedBrowserProcessPolicyOptions {
  process: LocalOwnedBrowserProcessAuthority | null;
  target: LocalOwnedBrowserTargetAuthority | null;
  keepBrowser: boolean;
  userDataDir: string;
  logger: BrowserLogger;
  manualProcessErrorPrefix?: string;
  settleManualProcess?: (
    owner: Extract<LocalOwnedBrowserProcessAuthority, { kind: "manual" }>["owner"],
  ) => Promise<LocalOwnedBrowserProcessSettlement>;
  settleTemporaryProcess?: (
    chrome: Extract<LocalOwnedBrowserProcessAuthority, { kind: "temporary" }>["chrome"],
  ) => Promise<LocalOwnedBrowserProcessSettlement>;
}

export async function settleLocalOwnedBrowserProcess(
  options: LocalOwnedBrowserProcessPolicyOptions,
): Promise<LocalOwnedBrowserProcessSettlement> {
  const process = options.process;
  if (!process) return { status: "completed", disposition: "preserved" };
  if (process.kind === "manual") {
    let processSettlement: LocalOwnedBrowserProcessSettlement;
    if (options.settleManualProcess) {
      processSettlement = await options.settleManualProcess(process.owner);
    } else if (options.keepBrowser && process.owner.disposition === "close-on-last-lease") {
      try {
        await releaseManualChromeOwnerEndpointAuthority(process.owner);
        processSettlement = { status: "completed", disposition: "preserved" };
      } catch (error) {
        processSettlement = {
          status: "pending",
          reason: `Exact Chrome endpoint release failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    } else {
      const settlement = await settleManualChromeOwner(
        options.userDataDir,
        process.owner,
        options.logger,
      );
      processSettlement =
        settlement.status === "unsafe"
          ? {
              status: "pending",
              reason: options.manualProcessErrorPrefix
                ? `${options.manualProcessErrorPrefix}: ${settlement.reason}`
                : settlement.reason,
            }
          : {
              status: "completed",
              disposition: settlement.status === "terminated" ? "terminated" : "preserved",
            };
    }
    if (processSettlement.status === "completed" && processSettlement.disposition === "preserved") {
      try {
        process.owner.chrome.process?.unref?.();
      } catch {
        // Best effort only; retained process ownership is already explicit in runtime metadata.
      }
    }
    return processSettlement;
  }

  const chrome = process.chrome;
  if (options.settleTemporaryProcess) {
    return await options.settleTemporaryProcess(chrome);
  }
  if (options.keepBrowser) {
    if (!options.target?.releasesProcessEndpointOnSettle) {
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
    options.logger(
      `Chrome left running on port ${chrome.port} with profile ${options.userDataDir}`,
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
    options.userDataDir,
    chrome.processIdentity.profileDirectory,
  ).catch(() => false);
  return removed
    ? { status: "completed", disposition: "terminated" }
    : {
        status: "pending",
        reason: `Profile removal was not confirmed: ${options.userDataDir}`,
      };
}
