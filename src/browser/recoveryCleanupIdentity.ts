import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  establishPrivateRuntimeAuthority,
  parseTemporaryProfileAuthority,
} from "../privateTempRoot.js";
import type { BrowserRecoveryCleanupResourceMetadata } from "../sessionManager.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import {
  parseProfileDirectoryIdentity,
  verifyProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
} from "./profileState.js";
import type { RecoveryCleanupEntry, RecoveryCleanupGroup } from "./reattachCleanupTypes.js";
export function groupRecoveryCleanupResources(
  runtime: BrowserRuntimeMetadata,
): RecoveryCleanupGroup[] {
  const entries: RecoveryCleanupEntry[] = (runtime.recoveryCleanupResources ?? []).map(
    (resource, order) => ({ resource, order }),
  );
  const unique = new Map<string, RecoveryCleanupEntry>();
  for (const entry of entries) {
    const key = recoveryCleanupResourceKey(entry.resource);
    if (!unique.has(key)) unique.set(key, entry);
  }

  const groups = new Map<string, RecoveryCleanupGroup>();
  for (const entry of unique.values()) {
    const key = recoveryCleanupGroupKey(entry.resource);
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { key, entries: [entry] });
  }
  return [...groups.values()];
}

export function recoveryCleanupGroupKey(resource: BrowserRecoveryCleanupResourceMetadata): string {
  if (!resource.remoteRecovery) {
    const processIdentity = resource.chromeProcessIdentity;
    const temporaryProfile = parseTemporaryProfileAuthority(resource.temporaryProfileAuthority);
    const persistedProfileIdentity = profileDirectoryIdentityKey(
      temporaryProfile?.profileDirectory ??
        processIdentity?.profileDirectory ??
        resource.profileDirectoryIdentity,
    );
    const profilePath = resource.chromeProfileRoot ?? resource.userDataDir;
    const profileIdentity =
      persistedProfileIdentity ??
      (profilePath
        ? ["missing-physical-profile", profilePath]
        : !processIdentity && resource.recoveryCleanup.profileKind === "none"
          ? [
              "processless-browser-endpoint",
              resource.chromeBrowserWSEndpoint ?? null,
              resource.chromeHost ?? null,
              resource.chromePort ?? null,
            ]
          : ["missing-physical-profile", null]);
    return JSON.stringify([
      "local",
      chromeProcessIdentityKey(processIdentity),
      profileIdentity,
      temporaryProfileAuthorityKey(resource.temporaryProfileAuthority),
    ]);
  }
  const remoteIdentity = remoteRecoveryIdentityKey(resource.remoteRecovery);
  return JSON.stringify(
    remoteIdentity
      ? ["remote", remoteIdentity]
      : [
          "remote-missing-authority",
          immutablePromptIdentity(resource.promptEpoch),
          resource.conversationId ?? null,
          resource.chromeProfileRoot ?? resource.userDataDir ?? null,
        ],
  );
}

export function recoveryCleanupResourceKey(
  resource: BrowserRecoveryCleanupResourceMetadata,
): string {
  return JSON.stringify([
    recoveryCleanupGroupKey(resource),
    resource.chromeTargetId ?? null,
    resource.chromeHost ?? null,
    resource.chromePort ?? null,
    resource.chromeBrowserWSEndpoint ?? null,
    resource.chromeProcessIdentity?.launchNonce ?? null,
    profileDirectoryIdentityKey(resource.profileDirectoryIdentity) ?? null,
    temporaryProfileAuthorityKey(resource.temporaryProfileAuthority),
    browserTabLeaseAuthorityKey(resource.tabLease),
    [
      resource.targetCloseCapability?.version ?? null,
      resource.targetCloseCapability?.generationId ?? null,
      resource.targetCloseCapability?.capabilityId ?? null,
      resource.targetCloseCapability?.ownerIdSha256 ?? null,
      resource.targetCloseCapability?.targetId ?? null,
      resource.targetCloseCapability?.browserWSEndpoint ?? null,
    ],
    resource.acquisition?.generationId ?? null,
    resource.acquisition?.pendingResource ?? null,
    [
      resource.acquisition?.processLaunchClaim?.version ?? null,
      resource.acquisition?.processLaunchClaim?.generationId ?? null,
      resource.acquisition?.processLaunchClaim?.nonce ?? null,
    ],
    resource.acquisition?.processOwnerDisposition ?? null,
    resource.acquisition?.targetMarkerUrl ?? null,
    Boolean(resource.remoteRecovery),
    resource.recoveryCleanup.ownsTarget,
    resource.recoveryCleanup.profileKind,
    resource.recoveryCleanup.keepBrowser,
    resource.recoveryCleanup.closeOwnedTargetOnComplete ?? null,
  ]);
}

export function chromeProcessIdentityKey(
  identity: BrowserRecoveryCleanupResourceMetadata["chromeProcessIdentity"],
): readonly unknown[] | null {
  if (!identity) return null;
  return [
    identity.pid,
    identity.processStartTime,
    identity.executablePath,
    identity.normalizedUserDataDir,
    identity.launchNonce,
    [
      identity.launchClaim?.version ?? null,
      identity.launchClaim?.generationId ?? null,
      identity.launchClaim?.nonce ?? null,
    ],
    profileDirectoryIdentityKey(identity.profileDirectory) ?? ["missing-physical-profile"],
  ];
}

export function physicalProfileDirectoryIdentity(
  identity: unknown,
): ProfileDirectoryIdentity | null {
  return parseProfileDirectoryIdentity(identity, process.platform);
}

function profileDirectoryIdentityKey(identity: unknown): readonly unknown[] | null {
  const physicalProfile = physicalProfileDirectoryIdentity(identity);
  if (!physicalProfile) return null;
  return [
    physicalProfile.version,
    physicalProfile.platform,
    physicalProfile.canonicalPath,
    physicalProfile.device,
    physicalProfile.inode,
    physicalProfile.birthtimeNs,
  ];
}

export function temporaryProfileAuthorityKey(authority: unknown): readonly unknown[] | null {
  const parsed = parseTemporaryProfileAuthority(authority);
  if (!parsed) return null;
  return [
    parsed.version,
    parsed.kind,
    parsed.generation.platform,
    parsed.generation.path,
    parsed.generation.identity.device,
    parsed.generation.identity.inode,
    parsed.generation.identity.birthtimeNs,
    parsed.generation.parent.path,
    parsed.generation.parent.identity.device,
    parsed.generation.parent.identity.inode,
    parsed.generation.parent.identity.birthtimeNs,
    profileDirectoryIdentityKey(parsed.profileDirectory),
  ];
}

export function browserTabLeaseAuthorityKey(
  lease: BrowserRecoveryCleanupResourceMetadata["tabLease"],
): string | null {
  if (!lease) return null;
  return JSON.stringify([
    lease.id,
    lease.generationId,
    profileDirectoryIdentityKey(lease.profileDirectory),
  ]);
}

export function immutablePromptIdentity(
  promptEpoch: BrowserRecoveryCleanupResourceMetadata["promptEpoch"],
): readonly unknown[] | null {
  if (!promptEpoch) return null;
  return [
    promptEpoch.epochId,
    promptEpoch.promptSha256,
    promptEpoch.followUpOrdinal,
    promptEpoch.status === "committed" ? promptEpoch.conversationId : null,
  ];
}

function remoteRecoveryIdentityKey(
  authority: BrowserRecoveryCleanupResourceMetadata["remoteRecovery"],
): readonly unknown[] | null {
  return authority ? [authority.protocolVersion, authority.host, authority.transactionToken] : null;
}

export function requestsProcessTeardown(resource: BrowserRecoveryCleanupResourceMetadata): boolean {
  const cleanup = resource.recoveryCleanup;
  return !resource.remoteRecovery && !cleanup.keepBrowser && cleanup.profileKind !== "none";
}

export function teardownOnlyEntry(entry: RecoveryCleanupEntry): RecoveryCleanupEntry {
  return {
    order: entry.order,
    resource: {
      ...entry.resource,
      chromeTargetId: undefined,
      targetCloseCapability: undefined,
      recoveryCleanup: {
        ...entry.resource.recoveryCleanup,
        ownsTarget: false,
        closeOwnedTargetOnComplete: undefined,
      },
    },
  };
}

export function removeReleasedLeaseAuthority(
  entry: RecoveryCleanupEntry,
  releasedLeaseAuthorities: Set<string>,
): RecoveryCleanupEntry {
  const leaseAuthority = browserTabLeaseAuthorityKey(entry.resource.tabLease);
  if (!leaseAuthority || !releasedLeaseAuthorities.has(leaseAuthority)) return entry;
  return {
    ...entry,
    resource: { ...entry.resource, tabLease: undefined },
  };
}

export async function validateGroupTeardownInvariants(
  entries: RecoveryCleanupEntry[],
): Promise<string | null> {
  const first = entries[0]?.resource;
  if (!first) return "Cleanup group has no teardown authority";
  const firstProcessIdentity = first.chromeProcessIdentity;
  const firstTemporaryProfile = parseTemporaryProfileAuthority(first.temporaryProfileAuthority);
  const firstProfileDirectory = physicalProfileDirectoryIdentity(
    firstTemporaryProfile?.profileDirectory ??
      firstProcessIdentity?.profileDirectory ??
      first.profileDirectoryIdentity,
  );
  const fallbackProfileSource = firstProcessIdentity
    ? null
    : (first.chromeProfileRoot ?? first.userDataDir);
  const fallbackProfile = fallbackProfileSource ? path.resolve(fallbackProfileSource) : null;
  const firstTemporaryProfileAuthority = temporaryProfileAuthorityKey(
    first.temporaryProfileAuthority,
  );
  const requiresTemporaryProfileAuthority =
    first.recoveryCleanup.profileKind === "temporary" ||
    first.recoveryCleanup.profileKind === "copied";
  if (requiresTemporaryProfileAuthority && !firstTemporaryProfileAuthority) {
    return "Cleanup group has no exact temporary-profile authority";
  }
  for (const { resource } of entries) {
    if (recoveryCleanupGroupKey(resource) !== recoveryCleanupGroupKey(first)) {
      return "Cleanup group contains conflicting Chrome process identities";
    }
    if (resource.recoveryCleanup.profileKind !== first.recoveryCleanup.profileKind) {
      return "Cleanup group contains conflicting profile teardown metadata";
    }
    if (
      JSON.stringify(temporaryProfileAuthorityKey(resource.temporaryProfileAuthority)) !==
      JSON.stringify(firstTemporaryProfileAuthority)
    ) {
      return "Cleanup group contains conflicting temporary-profile authorities";
    }
    if (firstProfileDirectory) {
      if (
        resource.userDataDir &&
        !(await cleanupProfileAbsent(resource.userDataDir)) &&
        !(await verifyProfileDirectoryIdentity(resource.userDataDir, firstProfileDirectory))
      ) {
        return "Cleanup group user-data directory does not match its process identity";
      }
      if (
        resource.chromeProfileRoot &&
        !(await cleanupProfileAbsent(resource.chromeProfileRoot)) &&
        !(await verifyProfileDirectoryIdentity(resource.chromeProfileRoot, firstProfileDirectory))
      ) {
        return "Cleanup group profile root does not match its process identity";
      }
    } else {
      if (
        fallbackProfile &&
        resource.userDataDir &&
        path.resolve(resource.userDataDir) !== fallbackProfile
      ) {
        return "Cleanup group user-data directory does not match its process identity";
      }
      if (
        fallbackProfile &&
        resource.chromeProfileRoot &&
        path.resolve(resource.chromeProfileRoot) !== fallbackProfile
      ) {
        return "Cleanup group profile root does not match its process identity";
      }
    }
  }
  return null;
}

export async function cleanupProfileAbsent(profileDir: string): Promise<boolean> {
  try {
    await access(profileDir);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function privateRecoveryLockPath(identity: string): Promise<string> {
  const root = await establishPrivateRuntimeAuthority();
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return path.join(root.path, `browser-recovery-${digest}.lock`);
}

export async function recoveryLockPathForOwner(ownerId: string): Promise<string> {
  const owner = ownerId.trim();
  if (!owner) throw new Error("Browser recovery lock owner id is required");
  return await privateRecoveryLockPath(JSON.stringify(["recovery-owner-v1", owner]));
}

export async function defaultRecoveryLockPath(runtime: BrowserRuntimeMetadata): Promise<string> {
  const cleanupAuthority = (runtime.recoveryCleanupResources ?? []).map((resource) =>
    recoveryCleanupResourceKey(resource),
  );
  return await privateRecoveryLockPath(
    JSON.stringify([
      "recovery-v4",
      cleanupAuthority,
      immutablePromptIdentity(runtime.promptEpoch),
      runtime.conversationId ?? null,
    ]),
  );
}
