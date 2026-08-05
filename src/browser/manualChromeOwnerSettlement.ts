import {
  cleanupStaleProfileState,
  isSafeChromeTerminationOutcome,
  readOracleChromeOwner,
  sameChromeProcessIdentity,
  type OracleChromeOwnerRecord,
} from "./profileState.js";
import type { BrowserLogger } from "./types.js";
import type { ManualChromeOwner } from "./manualChromeOwner.js";

export type ManualChromeOwnerSettlement =
  | { status: "terminated" }
  | { status: "preserved" }
  | { status: "unsafe"; reason: string };

export interface ManualChromeOwnerSettlementDeps {
  cleanupProfileState?: typeof cleanupStaleProfileState;
  readOwner?: typeof readOracleChromeOwner;
}

export async function releaseManualChromeOwnerEndpointAuthority(
  owner: ManualChromeOwner,
): Promise<void> {
  await owner.endpointAuthority?.release();
}

export async function settleManualChromeOwner(
  profileDir: string,
  owner: ManualChromeOwner,
  logger: BrowserLogger,
  deps: ManualChromeOwnerSettlementDeps = {},
): Promise<ManualChromeOwnerSettlement> {
  let current: OracleChromeOwnerRecord | null;
  try {
    current = await (deps.readOwner ?? readOracleChromeOwner)(profileDir);
  } catch (error) {
    return {
      status: "unsafe",
      reason: `Canonical Chrome owner authority is unreadable: ${error instanceof Error ? error.message : error}`,
    };
  }

  if (!current) {
    try {
      await releaseManualChromeOwnerEndpointAuthority(owner);
      return { status: "preserved" };
    } catch (error) {
      return {
        status: "unsafe",
        reason: `Exact Chrome control channel could not be released: ${error instanceof Error ? error.message : error}`,
      };
    }
  }
  if (
    current.port !== owner.chrome.port ||
    !sameChromeProcessIdentity(current.processIdentity, owner.processIdentity)
  ) {
    return {
      status: "unsafe",
      reason: "Canonical Chrome owner authority no longer matches the retained process endpoint",
    };
  }
  if (current.disposition === "preserve") {
    try {
      await releaseManualChromeOwnerEndpointAuthority(owner);
      return { status: "preserved" };
    } catch (error) {
      return {
        status: "unsafe",
        reason: `Exact Chrome control channel could not be released: ${error instanceof Error ? error.message : error}`,
      };
    }
  }
  const endpointAuthority = owner.endpointAuthority;
  if (!endpointAuthority) {
    return {
      status: "unsafe",
      reason: "Canonical Chrome owner has no retained exact endpoint teardown authority",
    };
  }
  const termination = await endpointAuthority.kill().catch((error: unknown) => ({
    status: "unsafe" as const,
    pid: owner.chrome.pid,
    reason: error instanceof Error ? error.message : String(error),
  }));
  if (!isSafeChromeTerminationOutcome(termination)) {
    return { status: "unsafe", reason: termination.reason };
  }
  let cleaned: boolean;
  try {
    cleaned = await (deps.cleanupProfileState ?? cleanupStaleProfileState)(profileDir, logger, {
      lockRemovalMode: "never",
      expectedProfileIdentity: owner.processIdentity.profileDirectory,
    });
  } catch (error) {
    return {
      status: "unsafe",
      reason: `Manual-login profile cleanup failed: ${error instanceof Error ? error.message : error}`,
    };
  }
  return cleaned
    ? { status: "terminated" }
    : { status: "unsafe", reason: "Manual-login profile cleanup was not confirmed" };
}
