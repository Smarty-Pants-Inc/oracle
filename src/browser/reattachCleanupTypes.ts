import type { BrowserRecoveryCleanupResourceMetadata } from "../sessionManager.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import type { settleRemoteBrowserRecovery } from "../remote/client.js";
import type {
  closeChromeTarget,
  closeChromeTargetWithExactAuthority,
  listChromeTargetsWithExactAuthority,
  listRemoteChromeTargets,
  retainChromeEndpointAuthority,
} from "./chromeLifecycle.js";
import type {
  acquireProfileRunLock,
  captureChromeProcessIdentity,
  cleanupStaleProfileState,
  inspectChromeProcessIdentity,
  inspectRunningChromeProcessesForLaunchClaim,
  readOracleChromeOwner,
  terminateRecordedChromeForProfile,
  verifyChromeProcessIdentity,
  verifyProfileDirectoryIdentity,
  writeOracleChromeOwner,
} from "./profileState.js";
import type {
  releaseBrowserTabLease,
  teardownBrowserResourcesIfNoActiveLeases,
} from "./tabLeaseRegistry.js";
import type { BrowserCaptureFinalizationResult } from "./types.js";

export interface ReattachCleanupDeps {
  closeChromeTarget?: typeof closeChromeTarget;
  closeChromeTargetWithExactAuthority?: typeof closeChromeTargetWithExactAuthority;
  listChromeTargets?: typeof listRemoteChromeTargets;
  listChromeTargetsWithExactAuthority?: typeof listChromeTargetsWithExactAuthority;
  retainChromeEndpointAuthority?: typeof retainChromeEndpointAuthority;
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
  teardownBrowserResourcesIfNoActiveLeases?: typeof teardownBrowserResourcesIfNoActiveLeases;
  removeProfile?: (profileDir: string) => Promise<boolean>;
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
  pending: RecoveryCleanupEntry[];
  errors: string[];
}

export interface ProcessAcquisitionReconciliationResult extends RecoveryCleanupPhaseResult {
  runtime: BrowserRuntimeMetadata;
}
