import { randomUUID } from "node:crypto";
import {
  isChromeExecutablePath,
  isChromeSnapshotForUserDataDir,
  normalizeExecutablePath,
  normalizeProfileArgument,
  readChromeSnapshotLaunchClaim,
  type ChromeProcessSnapshot,
} from "./chromeProcessCommandParsing.js";
import {
  isChromeProcessNonce,
  parseChromeProcessLaunchClaim,
  sameChromeProcessLaunchClaim,
  type ChromeProcessLaunchClaim,
} from "./chromeProcessLaunchClaim.js";
import { readChromeProcessSnapshot, type ProcessCommandExecutor } from "./chromeProcessProbe.js";
import {
  captureProfileDirectoryIdentity,
  parseProfileDirectoryIdentity,
  sameProfileDirectoryIdentity,
  verifyProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
} from "./profileDirectoryAuthority.js";
import {
  comparePlatformProcessGenerations,
  type TrustedProcessProbe,
} from "./platformProcessGeneration.js";

export interface ChromeProcessIdentity {
  readonly pid: number;
  readonly processStartTime: string;
  readonly executablePath: string;
  readonly normalizedUserDataDir: string;
  readonly launchNonce: string;
  readonly launchClaim?: ChromeProcessLaunchClaim;
  readonly profileDirectory: ProfileDirectoryIdentity;
}

export type ChromeProcessIdentityInspection = "current" | "exited" | "unavailable";

export interface ChromeProcessIdentityDeps {
  readonly platform?: NodeJS.Platform;
  readonly execute?: ProcessCommandExecutor;
  readonly trustedProcessProbe?: TrustedProcessProbe | null;
  readonly launchClaim?: ChromeProcessLaunchClaim;
  readonly readProcessSnapshot?: (pid: number) => Promise<ChromeProcessSnapshot | null>;
  readonly captureProfileIdentity?: (userDataDir: string) => Promise<ProfileDirectoryIdentity>;
  readonly verifyProfileIdentity?: (
    userDataDir: string,
    identity: ProfileDirectoryIdentity,
  ) => Promise<boolean>;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export async function captureChromeProcessIdentity(
  userDataDir: string,
  pid: number,
  launchClaim?: ChromeProcessLaunchClaim,
): Promise<ChromeProcessIdentity> {
  return captureChromeProcessIdentityWithDeps(userDataDir, pid, { launchClaim });
}

export async function captureChromeProcessIdentityForTest(
  userDataDir: string,
  pid: number,
  deps: ChromeProcessIdentityDeps,
): Promise<ChromeProcessIdentity> {
  return captureChromeProcessIdentityWithDeps(userDataDir, pid, deps);
}

async function captureChromeProcessIdentityWithDeps(
  userDataDir: string,
  pid: number,
  deps: ChromeProcessIdentityDeps,
): Promise<ChromeProcessIdentity> {
  const platform = deps.platform ?? process.platform;
  const launchClaim =
    deps.launchClaim === undefined ? null : parseChromeProcessLaunchClaim(deps.launchClaim);
  if (deps.launchClaim !== undefined && !launchClaim) {
    throw new Error("Cannot capture Chrome process identity with an invalid launch claim");
  }
  const profileDirectory = await (deps.captureProfileIdentity
    ? deps.captureProfileIdentity(userDataDir)
    : captureProfileDirectoryIdentity(userDataDir));
  const normalizedUserDataDir = normalizeProfileArgument(profileDirectory.canonicalPath, platform);
  if (!Number.isInteger(pid) || pid <= 0 || !normalizedUserDataDir) {
    throw new Error(`Cannot capture Chrome process identity for ${userDataDir}`);
  }
  const snapshot = await (deps.readProcessSnapshot
    ? deps.readProcessSnapshot(pid)
    : readChromeProcessSnapshot(pid, platform, deps));
  const executablePath = snapshot
    ? normalizeExecutablePath(snapshot.executablePath, platform)
    : null;
  if (
    !snapshot ||
    snapshot.pid !== pid ||
    !snapshot.processStartTime.trim() ||
    !executablePath ||
    !isChromeExecutablePath(executablePath, platform) ||
    !isChromeSnapshotForUserDataDir(snapshot, profileDirectory.canonicalPath, platform) ||
    (launchClaim &&
      !sameChromeProcessLaunchClaim(readChromeSnapshotLaunchClaim(snapshot, platform), launchClaim))
  ) {
    throw new Error(`Chrome pid ${pid} does not have a stable identity for ${userDataDir}`);
  }
  return Object.freeze({
    pid,
    processStartTime: snapshot.processStartTime.trim(),
    executablePath,
    normalizedUserDataDir,
    launchNonce: launchClaim?.nonce ?? randomUUID(),
    ...(launchClaim ? { launchClaim } : {}),
    profileDirectory,
  });
}

export async function inspectChromeProcessIdentity(
  userDataDir: string,
  identity: ChromeProcessIdentity,
): Promise<ChromeProcessIdentityInspection> {
  return inspectChromeProcessIdentityWithDeps(userDataDir, identity, {});
}

export async function inspectChromeProcessIdentityForTest(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  deps: ChromeProcessIdentityDeps,
): Promise<ChromeProcessIdentityInspection> {
  return inspectChromeProcessIdentityWithDeps(userDataDir, identity, deps);
}

export async function inspectChromeProcessIdentityWithDeps(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  deps: ChromeProcessIdentityDeps,
): Promise<ChromeProcessIdentityInspection> {
  const platform = deps.platform ?? process.platform;
  const validated = parseChromeProcessIdentity(identity, platform);
  if (!validated || !sameChromeProcessIdentity(validated, identity)) return "unavailable";
  const physicalProfileMatches = await (deps.verifyProfileIdentity
    ? deps.verifyProfileIdentity(userDataDir, identity.profileDirectory)
    : verifyProfileDirectoryIdentity(userDataDir, identity.profileDirectory));
  if (!physicalProfileMatches) return "unavailable";
  const normalizedUserDataDir = normalizeProfileArgument(
    identity.profileDirectory.canonicalPath,
    platform,
  );
  if (!normalizedUserDataDir || identity.normalizedUserDataDir !== normalizedUserDataDir) {
    return "unavailable";
  }

  const processAlive = deps.isProcessAlive ?? isProcessAlive;
  if (!processAlive(identity.pid)) return "exited";
  const snapshot = await (deps.readProcessSnapshot
    ? deps.readProcessSnapshot(identity.pid)
    : readChromeProcessSnapshot(identity.pid, platform, deps));
  if (!snapshot) return processAlive(identity.pid) ? "unavailable" : "exited";
  if (snapshot.pid !== identity.pid) return "unavailable";
  const generationComparison = comparePlatformProcessGenerations(
    identity.processStartTime,
    snapshot.processStartTime.trim(),
  );
  if (generationComparison === "different") return "exited";
  const launchClaimMatches = identity.launchClaim
    ? sameChromeProcessLaunchClaim(
        readChromeSnapshotLaunchClaim(snapshot, platform),
        identity.launchClaim,
      )
    : false;
  const executablePath = normalizeExecutablePath(snapshot.executablePath, platform);
  if (
    executablePath !== identity.executablePath ||
    !isChromeSnapshotForUserDataDir(snapshot, identity.profileDirectory.canonicalPath, platform) ||
    (generationComparison === "incomparable" && !launchClaimMatches) ||
    (identity.launchClaim && !launchClaimMatches)
  ) {
    return "unavailable";
  }
  return "current";
}

export function sameChromeProcessIdentity(
  left: ChromeProcessIdentity,
  right: ChromeProcessIdentity,
): boolean {
  return (
    left.pid === right.pid &&
    left.processStartTime === right.processStartTime &&
    left.executablePath === right.executablePath &&
    left.normalizedUserDataDir === right.normalizedUserDataDir &&
    left.launchNonce === right.launchNonce &&
    sameChromeProcessLaunchClaim(left.launchClaim, right.launchClaim) &&
    sameProfileDirectoryIdentity(left.profileDirectory, right.profileDirectory)
  );
}

export function parseChromeProcessIdentity(
  value: unknown,
  platform: NodeJS.Platform,
): ChromeProcessIdentity | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.processStartTime !== "string" ||
    !record.processStartTime.trim() ||
    typeof record.executablePath !== "string" ||
    typeof record.normalizedUserDataDir !== "string" ||
    !isChromeProcessNonce(record.launchNonce)
  ) {
    return null;
  }
  const launchClaim =
    record.launchClaim === undefined ? null : parseChromeProcessLaunchClaim(record.launchClaim);
  if (
    record.launchClaim !== undefined &&
    (!launchClaim || launchClaim.nonce !== record.launchNonce)
  ) {
    return null;
  }
  const processStartTime = record.processStartTime.trim();
  if (
    platform === "linux" &&
    processStartTime.startsWith("linux:") &&
    !/^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/iu.test(
      processStartTime,
    )
  ) {
    return null;
  }
  const executablePath = normalizeExecutablePath(record.executablePath, platform);
  const normalizedUserDataDir = normalizeProfileArgument(record.normalizedUserDataDir, platform);
  const profileDirectory = parseProfileDirectoryIdentity(record.profileDirectory, platform);
  if (
    !executablePath ||
    !normalizedUserDataDir ||
    normalizedUserDataDir !== record.normalizedUserDataDir ||
    executablePath !== record.executablePath ||
    !profileDirectory ||
    normalizedUserDataDir !== normalizeProfileArgument(profileDirectory.canonicalPath, platform)
  ) {
    return null;
  }
  return Object.freeze({
    pid: record.pid,
    processStartTime,
    executablePath,
    normalizedUserDataDir,
    launchNonce: record.launchNonce,
    ...(launchClaim ? { launchClaim } : {}),
    profileDirectory,
  });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means "exists but no permission"; treat as alive.
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}
