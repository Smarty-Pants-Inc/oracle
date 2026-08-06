import type { BrowserRecoveryCleanupResourceMetadata } from "../sessionManager.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import type { settleRemoteBrowserRecovery } from "../remote/client.js";
import type {
  closeChromeTargetWithExactAuthority,
  listChromeTargetsWithExactAuthority,
  retainChromeEndpointAuthority,
} from "./chromeLifecycle.js";
import type { retainChromeBrowserWebSocketAuthority } from "./chromeEndpointAuthority.js";
import type { closeChromeTargetWithRetainedCapability } from "./targetCloseAuthority.js";
import type { settleManualChromeOwner } from "./manualChromeOwnerSettlement.js";
import type {
  captureChromeProcessIdentity,
  inspectChromeProcessIdentity,
} from "./chromeProcessIdentity.js";
import type { inspectRunningChromeProcessesForLaunchClaim } from "./chromeProcessDiscovery.js";
import type {
  acquireProfileRunLock,
  cleanupStaleProfileState,
  readOracleChromeOwner,
  terminateRecordedChromeForProfile,
  verifyChromeProcessIdentity,
  verifyProfileDirectoryIdentity,
  writeOracleChromeOwner,
  ProfileDirectoryIdentity,
} from "./profileState.js";
import type {
  releaseBrowserTabLease,
  teardownBrowserResourcesIfNoActiveLeases,
} from "./tabLeaseRegistry.js";
import type { BrowserCaptureFinalizationResult } from "./types.js";

export interface ReattachCleanupDeps {
  /** Trusted session/transaction owner for live target and lease capabilities. */
  ownerId?: string;
  closeChromeTargetWithExactAuthority?: typeof closeChromeTargetWithExactAuthority;
  listChromeTargetsWithExactAuthority?: typeof listChromeTargetsWithExactAuthority;
  closeChromeTargetWithRetainedCapability?: typeof closeChromeTargetWithRetainedCapability;
  retainChromeEndpointAuthority?: typeof retainChromeEndpointAuthority;
  retainChromeBrowserWebSocketAuthority?: typeof retainChromeBrowserWebSocketAuthority;
  captureChromeProcessIdentity?: typeof captureChromeProcessIdentity;
  inspectRunningChromeProcessesForLaunchClaim?: typeof inspectRunningChromeProcessesForLaunchClaim;
  acquireProfileRunLock?: typeof acquireProfileRunLock;
  inspectChromeProcessIdentity?: typeof inspectChromeProcessIdentity;
  verifyProfileDirectoryIdentity?: typeof verifyProfileDirectoryIdentity;
  terminateRecordedChromeForProfile?: typeof terminateRecordedChromeForProfile;
  terminateExactChromeForProfile?: typeof terminateRecordedChromeForProfile;
  readOracleChromeOwner?: typeof readOracleChromeOwner;
  verifyChromeProcessIdentity?: typeof verifyChromeProcessIdentity;
  writeOracleChromeOwner?: typeof writeOracleChromeOwner;
  cleanupStaleProfileState?: typeof cleanupStaleProfileState;
  settleManualChromeOwner?: typeof settleManualChromeOwner;
  teardownBrowserResourcesIfNoActiveLeases?: typeof teardownBrowserResourcesIfNoActiveLeases;
  removeProfile?: (
    profileDir: string,
    expectedIdentity: ProfileDirectoryIdentity,
  ) => Promise<boolean>;
  releaseBrowserTabLease?: typeof releaseBrowserTabLease;
  settleRemoteBrowserRecovery?: typeof settleRemoteBrowserRecovery;
  resolveRemoteRecoveryConfig?: () => Promise<{ host?: string; token?: string }>;
  isRemotePublicationAcknowledged?: () => boolean;
}

export type ReattachFinalizationResult = BrowserCaptureFinalizationResult;
export type ReattachSettlementMode = "finalize" | "abort";

export interface RecoveryCleanupEntry {
  resource: BrowserRecoveryCleanupResourceMetadata;
  order: number;
}

export interface RecoveryCleanupGroup {
  key: string;
  entries: RecoveryCleanupEntry[];
}

export interface RecoveryCleanupPhaseResult {
  classification?: "legacy-session-target-authority";
  pending: RecoveryCleanupEntry[];
  errors: string[];
}

export interface ProcessAcquisitionReconciliationResult extends RecoveryCleanupPhaseResult {
  runtime: BrowserRuntimeMetadata;
}
