import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { readErrorCode } from "../fsDurability.js";
import {
  acquireCrashRecoverableFilesystemLock,
  type CrashRecoverableFilesystemLock,
  type CrashRecoverableFilesystemLockDeps,
  FilesystemLockBusyError,
} from "./filesystemLock.js";
import {
  isolateDirectoryGenerationForRemoval,
  removeIsolatedDirectoryGeneration,
  replayPendingIsolatedDirectoryRemovals,
} from "./filesystemLockDirectoryRemoval.js";
import {
  assertProfileDirectoryIdentity,
  captureProfileDirectoryIdentity,
  parseProfileDirectoryIdentity,
  sameProfileDirectoryIdentity,
  verifyProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
  type ProfileStateLogger,
} from "./profileDirectoryAuthority.js";
import { getDevToolsActivePortPaths } from "./profileDevToolsState.js";
import {
  inspectChromeProcessIdentityWithDeps,
  isProcessAlive,
  parseChromeProcessIdentity,
  sameChromeProcessIdentity,
  type ChromeProcessIdentity,
  type ChromeProcessIdentityDeps,
} from "./chromeProcessIdentity.js";
import {
  inspectChromeProfileDirectoryUse,
  isChromeUsingUserDataDir,
  revalidateChromeProfileDirectoryUse,
  type ChromeProfileDirectoryUnusedProof,
  type ChromeProfileDirectoryUseInspection,
} from "./chromeProfileDirectoryUse.js";

export * from "./profileDirectoryAuthority.js";
export * from "./profileDevToolsState.js";

const ORACLE_CHROME_OWNER_FILENAME = "oracle-chrome-owner.json";
const ORACLE_PROFILE_LOCK_FILENAME = "oracle-automation.lock";

async function canonicalProfileRemovalPath(userDataDir: string): Promise<string | null> {
  const resolvedPath = path.resolve(userDataDir);
  let canonicalParentPath: string;
  try {
    canonicalParentPath = await realpath(path.dirname(resolvedPath));
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  return path.join(canonicalParentPath, path.basename(resolvedPath));
}
export type ChromeOwnerDisposition = "preserve" | "close-on-last-lease";
export type ChromeOwnerPreservationPolicy = "service-persistent";

export interface OracleChromeOwnerRecord {
  readonly port: number;
  readonly processIdentity: ChromeProcessIdentity;
  readonly disposition: ChromeOwnerDisposition;
  /** Only the remote service may establish a preservation policy direct runs cannot replace. */
  readonly preservationPolicy?: ChromeOwnerPreservationPolicy;
}

interface ChromeOwnerProcessIdentityDeps extends ChromeProcessIdentityDeps {
  readonly readOwner?: (
    userDataDir: string,
  ) => Promise<{ processIdentity: ChromeProcessIdentity } | null>;
}

export interface ProfileDirectoryUseDeps {
  inspectChromeProfileDirectoryUse?: (
    expected: ProfileDirectoryIdentity,
  ) => Promise<ChromeProfileDirectoryUseInspection>;
  revalidateChromeProfileDirectoryUse?: (
    expected: ProfileDirectoryIdentity,
    previous: ChromeProfileDirectoryUnusedProof,
  ) => Promise<ChromeProfileDirectoryUseInspection>;
}

interface RemoveProfileDirectoryDeps extends ProfileDirectoryUseDeps {
  beforeQuarantineRename?: () => void | Promise<void>;
  beforeQuarantineDelete?: (quarantinePath: string) => void | Promise<void>;
  afterQuarantineIdentityVerification?: (quarantinePath: string) => void | Promise<void>;
  afterRemovalChildAttestation?: (isolatedRootPath: string) => void | Promise<void>;
}

export async function removeProfileDirectoryIfIdentityMatches(
  userDataDir: string,
  expected: ProfileDirectoryIdentity,
  deps: ProfileDirectoryUseDeps = {},
): Promise<boolean> {
  return removeProfileDirectoryIfIdentityMatchesWithDeps(userDataDir, expected, deps);
}

export async function removeProfileDirectoryIfIdentityMatchesForTest(
  userDataDir: string,
  expected: ProfileDirectoryIdentity,
  deps: RemoveProfileDirectoryDeps,
): Promise<boolean> {
  return removeProfileDirectoryIfIdentityMatchesWithDeps(userDataDir, expected, deps);
}

export async function replayPendingProfileDirectoryRemovals(userDataDir: string): Promise<void> {
  await replayPendingProfileDirectoryRemovalsWithDeps(userDataDir, {});
}

export async function replayPendingProfileDirectoryRemovalsForTest(
  userDataDir: string,
  deps: ProfileDirectoryUseDeps,
): Promise<void> {
  await replayPendingProfileDirectoryRemovalsWithDeps(userDataDir, deps);
}

async function replayPendingProfileDirectoryRemovalsWithDeps(
  userDataDir: string,
  deps: ProfileDirectoryUseDeps,
): Promise<void> {
  const canonicalPath = await canonicalProfileRemovalPath(userDataDir);
  if (canonicalPath === null) return;
  const guards = new Map<
    string,
    { identity: ProfileDirectoryIdentity; proof: ChromeProfileDirectoryUnusedProof }
  >();
  await replayPendingIsolatedDirectoryRemovals(path.dirname(canonicalPath), canonicalPath, {
    verifyGenerationForRemoval: async (generationPath) => {
      const existing = guards.get(generationPath);
      if (existing) {
        if (!(await verifyProfileDirectoryIdentity(generationPath, existing.identity)))
          return false;
        const inspection = await (
          deps.revalidateChromeProfileDirectoryUse ?? revalidateChromeProfileDirectoryUse
        )(existing.identity, existing.proof);
        if (inspection.status !== "unused") return false;
        existing.proof = inspection;
        return true;
      }
      const identity = await captureProfileDirectoryIdentity(generationPath);
      const inspection = await (
        deps.inspectChromeProfileDirectoryUse ?? inspectChromeProfileDirectoryUse
      )(identity);
      if (inspection.status !== "unused") return false;
      guards.set(generationPath, { identity, proof: inspection });
      return true;
    },
  });
}

async function removeProfileDirectoryIfIdentityMatchesWithDeps(
  userDataDir: string,
  expectedValue: ProfileDirectoryIdentity,
  deps: RemoveProfileDirectoryDeps,
): Promise<boolean> {
  const expected = parseProfileDirectoryIdentity(expectedValue, process.platform);
  if (!expected) return false;
  if (!(await pathExists(expected.canonicalPath))) return true;
  if (!(await verifyProfileDirectoryIdentity(userDataDir, expected))) return false;
  const inspectProfileUse =
    deps.inspectChromeProfileDirectoryUse ?? inspectChromeProfileDirectoryUse;
  const revalidateProfileUse =
    deps.revalidateChromeProfileDirectoryUse ?? revalidateChromeProfileDirectoryUse;
  let profileUse = await inspectProfileUse(expected);
  if (profileUse.status !== "unused") return false;
  let unusedProof: ChromeProfileDirectoryUnusedProof = profileUse;
  const revalidateUnusedProof = async (): Promise<boolean> => {
    profileUse = await revalidateProfileUse(expected, unusedProof);
    if (profileUse.status !== "unused") return false;
    unusedProof = profileUse;
    return true;
  };
  if (!(await verifyProfileDirectoryIdentity(userDataDir, expected))) return false;
  await deps.beforeQuarantineRename?.();
  if (!(await revalidateUnusedProof())) return false;

  const quarantinePath = path.join(
    path.dirname(expected.canonicalPath),
    `.${path.basename(expected.canonicalPath)}.oracle-delete-${process.pid}-${randomUUID()}`,
  );
  try {
    await rename(expected.canonicalPath, quarantinePath);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(readErrorCode(error) ?? "")) return false;
    throw error;
  }

  const quarantinedIdentity = Object.freeze({
    ...expected,
    canonicalPath: path.resolve(quarantinePath),
  });
  const restore = async (): Promise<void> => {
    if (await pathExists(expected.canonicalPath)) return;
    await rename(quarantinePath, expected.canonicalPath).catch(() => undefined);
  };
  if (
    !(await verifyProfileDirectoryIdentity(quarantinePath, quarantinedIdentity)) ||
    !(await revalidateUnusedProof())
  ) {
    await restore();
    return false;
  }

  await deps.beforeQuarantineDelete?.(quarantinePath);
  if (!(await verifyProfileDirectoryIdentity(quarantinePath, quarantinedIdentity))) return false;
  await deps.afterQuarantineIdentityVerification?.(quarantinePath);
  if (!(await revalidateUnusedProof())) {
    await restore();
    return false;
  }
  const verifyQuarantinedGeneration = async (generationPath: string): Promise<boolean> =>
    (await verifyProfileDirectoryIdentity(
      generationPath,
      Object.freeze({ ...expected, canonicalPath: path.resolve(generationPath) }),
    )) && (await revalidateUnusedProof());
  const isolation = await isolateDirectoryGenerationForRemoval(
    quarantinePath,
    verifyQuarantinedGeneration,
    expected.canonicalPath,
  );
  if (isolation.status !== "isolated") {
    await restore();
    return false;
  }
  await removeIsolatedDirectoryGeneration(isolation.rootPath, {
    afterChildAttestation: deps.afterRemovalChildAttestation,
    verifyGenerationForRemoval: verifyQuarantinedGeneration,
  });
  return true;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export async function readOracleChromeOwner(
  userDataDir: string,
): Promise<OracleChromeOwnerRecord | null> {
  let profile: ProfileDirectoryIdentity;
  try {
    profile = await captureProfileDirectoryIdentity(userDataDir);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  return readOracleChromeOwnerForProfile(userDataDir, profile);
}

// The caller's captured profile is the pre-read authority. The post-read assertion closes the
// replacement race without recapturing the same physical directory generation.
async function readOracleChromeOwnerForProfile(
  userDataDir: string,
  profile: ProfileDirectoryIdentity,
): Promise<OracleChromeOwnerRecord | null> {
  const ownerPath = path.join(profile.canonicalPath, ORACLE_CHROME_OWNER_FILENAME);
  let raw: string;
  try {
    raw = await readFile(ownerPath, "utf8");
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
    await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome owner authority read");
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Chrome owner authority is malformed: ${ownerPath}`);
  }
  const owner = parseOracleChromeOwnerRecord(value, process.platform);
  if (!owner || !sameProfileDirectoryIdentity(owner.processIdentity.profileDirectory, profile)) {
    throw new Error(`Chrome owner authority is invalid or stale: ${ownerPath}`);
  }
  await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome owner authority read");
  return owner;
}

export async function writeOracleChromeOwner(
  userDataDir: string,
  owner: OracleChromeOwnerRecord,
): Promise<void> {
  const validated = parseOracleChromeOwnerRecord(owner, process.platform);
  if (
    !validated ||
    !(await verifyProfileDirectoryIdentity(userDataDir, validated.processIdentity.profileDirectory))
  ) {
    throw new Error(`Chrome owner authority does not belong to ${userDataDir}`);
  }
  const profile = validated.processIdentity.profileDirectory;
  const ownerPath = path.join(profile.canonicalPath, ORACLE_CHROME_OWNER_FILENAME);
  const temporaryPath = path.join(
    profile.canonicalPath,
    `.${ORACLE_CHROME_OWNER_FILENAME}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome owner persistence");
    await rename(temporaryPath, ownerPath);
    await syncProfileDirectory(profile.canonicalPath);
    await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome owner persistence");
  } finally {
    if (await verifyProfileDirectoryIdentity(userDataDir, profile)) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function removeOracleChromeOwnerIfMatches(
  userDataDir: string,
  expectedOwner: OracleChromeOwnerRecord,
): Promise<boolean> {
  const expected = parseOracleChromeOwnerRecord(expectedOwner, process.platform);
  if (
    expected === null ||
    !(await verifyProfileDirectoryIdentity(userDataDir, expected.processIdentity.profileDirectory))
  ) {
    return false;
  }
  const profile = expected.processIdentity.profileDirectory;
  const ownerPath = path.join(profile.canonicalPath, ORACLE_CHROME_OWNER_FILENAME);
  const quarantinePath = path.join(
    profile.canonicalPath,
    `.${ORACLE_CHROME_OWNER_FILENAME}.remove-${process.pid}-${randomUUID()}`,
  );
  let quarantined = false;
  const restore = async (): Promise<void> => {
    if (
      !quarantined ||
      !(await verifyProfileDirectoryIdentity(userDataDir, profile)) ||
      (await pathExists(ownerPath))
    ) {
      return;
    }
    await rename(quarantinePath, ownerPath);
    quarantined = false;
    await syncProfileDirectory(profile.canonicalPath);
  };

  try {
    await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome owner removal");
    try {
      await rename(ownerPath, quarantinePath);
      quarantined = true;
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
      return verifyProfileDirectoryIdentity(userDataDir, profile);
    }
    await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome owner removal");
    let current: OracleChromeOwnerRecord | null = null;
    try {
      current = parseOracleChromeOwnerRecord(
        JSON.parse(await readFile(quarantinePath, "utf8")),
        process.platform,
      );
    } catch {
      // A malformed or unreadable record is not the caller's exact authority.
    }
    if (
      current === null ||
      current.port !== expected.port ||
      current.disposition !== expected.disposition ||
      current.preservationPolicy !== expected.preservationPolicy ||
      !sameChromeProcessIdentity(current.processIdentity, expected.processIdentity)
    ) {
      await restore();
      return false;
    }
    await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome owner removal");
    await rm(quarantinePath);
    quarantined = false;
    await syncProfileDirectory(profile.canonicalPath);
    await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome owner removal");
    return true;
  } catch (error) {
    await restore().catch(() => undefined);
    throw error;
  }
}

export async function verifyChromeProcessIdentity(
  userDataDir: string,
  identity: ChromeProcessIdentity,
): Promise<boolean> {
  return verifyChromeProcessIdentityWithDeps(userDataDir, identity, {});
}

export async function verifyChromeProcessIdentityForTest(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  deps: ChromeOwnerProcessIdentityDeps,
): Promise<boolean> {
  return verifyChromeProcessIdentityWithDeps(userDataDir, identity, deps);
}

async function verifyChromeProcessIdentityWithDeps(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  deps: ChromeOwnerProcessIdentityDeps,
): Promise<boolean> {
  let persistedOwner: { processIdentity: ChromeProcessIdentity } | null;
  try {
    persistedOwner = await (deps.readOwner
      ? deps.readOwner(userDataDir)
      : readOracleChromeOwner(userDataDir));
  } catch {
    return false;
  }
  if (!persistedOwner || !sameChromeProcessIdentity(persistedOwner.processIdentity, identity)) {
    return false;
  }
  return (await inspectChromeProcessIdentityWithDeps(userDataDir, identity, deps)) === "current";
}

export function parseOracleChromeOwnerRecord(
  value: unknown,
  platform: NodeJS.Platform,
): OracleChromeOwnerRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    !Object.hasOwn(record, "port") ||
    !Object.hasOwn(record, "processIdentity") ||
    Object.keys(record).some(
      (key) =>
        key !== "port" &&
        key !== "processIdentity" &&
        key !== "disposition" &&
        key !== "preservationPolicy",
    )
  ) {
    return null;
  }
  if (
    !Number.isInteger(record.port) ||
    (record.port as number) <= 0 ||
    (record.port as number) > 65_535
  ) {
    return null;
  }
  const disposition =
    record.disposition === undefined
      ? "preserve"
      : record.disposition === "preserve" || record.disposition === "close-on-last-lease"
        ? record.disposition
        : null;
  const preservationPolicy =
    record.preservationPolicy === undefined
      ? undefined
      : record.preservationPolicy === "service-persistent"
        ? record.preservationPolicy
        : null;
  const processIdentity = parseChromeProcessIdentity(record.processIdentity, platform);
  if (!processIdentity || !disposition || preservationPolicy === null) return null;
  return Object.freeze({
    port: record.port as number,
    processIdentity,
    disposition,
    ...(preservationPolicy ? { preservationPolicy } : {}),
  });
}

async function syncProfileDirectory(userDataDir: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(userDataDir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type RecordedChromeTerminationOutcome =
  | {
      status: "stopped";
      pid?: number;
      signal: "SIGTERM" | "SIGKILL" | "CONTROL_CHANNEL";
    }
  | { status: "already-stopped"; pid?: number }
  | { status: "unsafe"; reason: string; pid?: number };

export function isSafeChromeTerminationOutcome(
  outcome: RecordedChromeTerminationOutcome,
): outcome is Exclude<RecordedChromeTerminationOutcome, { status: "unsafe" }> {
  return outcome.status === "stopped" || outcome.status === "already-stopped";
}

interface RecordedChromeTerminationDeps extends ChromeOwnerProcessIdentityDeps {
  isChromeUsingUserDataDir?: (userDataDir: string) => Promise<boolean>;
}

async function terminateRecordedChromeForProfileWithDeps(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  logger: ProfileStateLogger | undefined,
  deps: RecordedChromeTerminationDeps,
): Promise<RecordedChromeTerminationOutcome> {
  const platform = deps.platform ?? process.platform;
  const validatedIdentity = parseChromeProcessIdentity(identity, platform);
  if (!validatedIdentity || !sameChromeProcessIdentity(validatedIdentity, identity)) {
    return { status: "unsafe", reason: `Chrome process identity is invalid for ${userDataDir}` };
  }
  const physicalProfileMatches = await (deps.verifyProfileIdentity
    ? deps.verifyProfileIdentity(userDataDir, identity.profileDirectory)
    : verifyProfileDirectoryIdentity(userDataDir, identity.profileDirectory));
  if (!physicalProfileMatches) {
    const reason = `Physical Chrome profile authority changed for ${userDataDir}`;
    logger?.(`${reason}; preserving cleanup state`);
    return { status: "unsafe", reason, pid: identity.pid };
  }
  let persistedOwner: { processIdentity: ChromeProcessIdentity } | null;
  try {
    persistedOwner = await (deps.readOwner
      ? deps.readOwner(userDataDir)
      : readOracleChromeOwner(userDataDir));
  } catch (error) {
    return {
      status: "unsafe",
      reason: error instanceof Error ? error.message : String(error),
      pid: identity.pid,
    };
  }
  if (!persistedOwner || !sameChromeProcessIdentity(persistedOwner.processIdentity, identity)) {
    const reason = `Chrome cleanup authority is stale for ${userDataDir}`;
    logger?.(`${reason}; preserving cleanup state`);
    return { status: "unsafe", reason, pid: identity.pid };
  }

  const pid = identity.pid;
  if (!(deps.isProcessAlive ?? isProcessAlive)(pid)) {
    if (await (deps.isChromeUsingUserDataDir ?? isChromeUsingUserDataDir)(userDataDir)) {
      return { status: "unsafe", reason: "another Chrome process is using the profile", pid };
    }
    return { status: "already-stopped", pid };
  }

  const reason =
    `Chrome pid ${pid} is still alive, but this recovered session has no retained stable process ` +
    "handle or authenticated exact Chrome control channel";
  logger?.(`${reason}; refusing PID-based termination and preserving cleanup state`);
  return { status: "unsafe", reason, pid };
}

export function terminateRecordedChromeForProfile(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  logger?: ProfileStateLogger,
): Promise<RecordedChromeTerminationOutcome> {
  return terminateRecordedChromeForProfileWithDeps(userDataDir, identity, logger, {});
}

export function terminateRecordedChromeForProfileForTest(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  logger: ProfileStateLogger | undefined,
  deps: RecordedChromeTerminationDeps,
): Promise<RecordedChromeTerminationOutcome> {
  return terminateRecordedChromeForProfileWithDeps(userDataDir, identity, logger, deps);
}

export interface ProfileRunLock {
  readonly path: string;
  readonly lockId: string;
  readonly profileDirectory: ProfileDirectoryIdentity;
  release: () => Promise<void>;
}

export async function acquireProfileRunLock(
  userDataDir: string,
  options: {
    timeoutMs: number;
    pollMs?: number;
    logger?: ProfileStateLogger;
    sessionId?: string;
  },
  deps: CrashRecoverableFilesystemLockDeps = {},
): Promise<ProfileRunLock | null> {
  const timeoutMs = options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  const pollMs =
    typeof options.pollMs === "number" && Number.isFinite(options.pollMs) && options.pollMs > 0
      ? options.pollMs
      : 1000;
  const profileDirectory = await captureProfileDirectoryIdentity(userDataDir, { create: true });
  if (!(await verifyProfileDirectoryIdentity(userDataDir, profileDirectory))) {
    throw new Error(`Profile directory identity changed before acquiring its lock: ${userDataDir}`);
  }
  const lockPath = path.join(profileDirectory.canonicalPath, ORACLE_PROFILE_LOCK_FILENAME);

  let filesystemLock: CrashRecoverableFilesystemLock;
  try {
    filesystemLock = await acquireCrashRecoverableFilesystemLock(
      lockPath,
      {
        timeoutMs,
        pollMs,
        createParent: false,
        sessionId: options.sessionId,
      },
      deps,
    );
  } catch (error) {
    if (error instanceof FilesystemLockBusyError) {
      const owner = error.owner ? ` by pid ${error.owner.pid}` : "";
      throw new Error(
        `Oracle profile lock at ${lockPath} remained held${owner} after ${Math.round(timeoutMs / 1000)}s`,
        { cause: error },
      );
    }
    throw error;
  }

  if (!(await verifyProfileDirectoryIdentity(userDataDir, profileDirectory))) {
    await filesystemLock.release();
    throw new Error(`Profile directory identity changed while acquiring its lock: ${userDataDir}`);
  }

  options.logger?.(`Acquired Oracle profile lock at ${lockPath}`);
  let releasePromise: Promise<void> | undefined;
  return {
    path: lockPath,
    lockId: filesystemLock.owner.ownerNonce,
    profileDirectory,
    release: () =>
      (releasePromise ??= (async () => {
        if (!(await verifyProfileDirectoryIdentity(userDataDir, profileDirectory))) {
          throw new Error(
            `Profile directory identity changed before releasing Oracle profile lock at ${lockPath}`,
          );
        }
        await filesystemLock.release();
        options.logger?.(`Released Oracle profile lock ${lockPath}`);
      })()),
  };
}

interface CleanupStaleProfileStateDeps extends ProfileDirectoryUseDeps {
  captureProfileIdentity?: typeof captureProfileDirectoryIdentity;
  verifyProfileIdentity?: typeof verifyProfileDirectoryIdentity;
  beforeDestructiveCleanup?: () => void | Promise<void>;
}

export async function cleanupStaleProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: {
    lockRemovalMode?: "never" | "if_oracle_pid_dead";
    expectedProfileIdentity?: ProfileDirectoryIdentity;
  } = {},
  deps: ProfileDirectoryUseDeps = {},
): Promise<boolean> {
  return cleanupStaleProfileStateWithDeps(userDataDir, logger, options, deps);
}

export async function cleanupStaleProfileStateForTest(
  userDataDir: string,
  logger: ProfileStateLogger | undefined,
  options: {
    lockRemovalMode?: "never" | "if_oracle_pid_dead";
    expectedProfileIdentity?: ProfileDirectoryIdentity;
  },
  deps: CleanupStaleProfileStateDeps,
): Promise<boolean> {
  return cleanupStaleProfileStateWithDeps(userDataDir, logger, options, deps);
}

async function cleanupStaleProfileStateWithDeps(
  userDataDir: string,
  logger: ProfileStateLogger | undefined,
  options: {
    lockRemovalMode?: "never" | "if_oracle_pid_dead";
    expectedProfileIdentity?: ProfileDirectoryIdentity;
  },
  deps: CleanupStaleProfileStateDeps,
): Promise<boolean> {
  const expectedProfile = options.expectedProfileIdentity
    ? parseProfileDirectoryIdentity(options.expectedProfileIdentity, process.platform)
    : null;
  if (options.expectedProfileIdentity && !expectedProfile) {
    logger?.("Refusing stale profile cleanup because its persisted identity is invalid");
    return false;
  }
  try {
    await replayPendingProfileDirectoryRemovalsWithDeps(userDataDir, deps);
  } catch (error) {
    logger?.(
      `Refusing stale profile cleanup because pending deletion replay failed: ${error instanceof Error ? error.message : error}`,
    );
    return false;
  }
  const captureProfile = deps.captureProfileIdentity ?? captureProfileDirectoryIdentity;
  const verifyProfile = deps.verifyProfileIdentity ?? verifyProfileDirectoryIdentity;
  let profile: ProfileDirectoryIdentity;
  try {
    profile = expectedProfile ?? (await captureProfile(userDataDir));
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return true;
    logger?.(`Refusing stale profile cleanup: ${error instanceof Error ? error.message : error}`);
    return false;
  }
  if (!(await verifyProfile(userDataDir, profile))) {
    logger?.(`Refusing stale profile cleanup because physical authority changed: ${userDataDir}`);
    return false;
  }
  const lockRemovalMode = options.lockRemovalMode ?? "never";
  if (lockRemovalMode === "if_oracle_pid_dead") {
    let owner: OracleChromeOwnerRecord | null;
    try {
      owner = await readOracleChromeOwnerForProfile(userDataDir, profile);
    } catch (error) {
      logger?.(
        `Refusing stale profile cleanup because Chrome owner authority is unreadable: ${error instanceof Error ? error.message : error}`,
      );
      return false;
    }
    const pid = owner?.processIdentity.pid;
    if (pid && isProcessAlive(pid)) {
      logger?.(`Chrome pid ${pid} still alive; preserving profile state`);
      return false;
    }
  }
  const inspectProfileUse =
    deps.inspectChromeProfileDirectoryUse ?? inspectChromeProfileDirectoryUse;
  const revalidateProfileUse =
    deps.revalidateChromeProfileDirectoryUse ?? revalidateChromeProfileDirectoryUse;
  let profileUse = await inspectProfileUse(profile);
  if (profileUse.status !== "unused") {
    logger?.(
      "Running Chrome profile use is present or could not be proven absent; preserving profile state",
    );
    return false;
  }
  let unusedProof: ChromeProfileDirectoryUnusedProof = profileUse;
  const revalidateUnusedProof = async (): Promise<boolean> => {
    profileUse = await revalidateProfileUse(profile, unusedProof);
    if (profileUse.status !== "unused") return false;
    unusedProof = profileUse;
    return true;
  };
  await deps.beforeDestructiveCleanup?.();

  let cleaned = true;
  for (const candidate of getDevToolsActivePortPaths(profile.canonicalPath)) {
    if (!(await verifyProfile(userDataDir, profile)) || !(await revalidateUnusedProof())) {
      return false;
    }
    try {
      await rm(candidate, { force: true });
      logger?.(`Removed stale DevToolsActivePort: ${candidate}`);
    } catch {
      cleaned = false;
    }
  }
  if (lockRemovalMode === "never") {
    return (
      cleaned && (await verifyProfile(userDataDir, profile)) && (await revalidateUnusedProof())
    );
  }

  const staleFiles = [
    "lockfile",
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    ORACLE_CHROME_OWNER_FILENAME,
  ];
  for (const staleFile of staleFiles) {
    if (!(await verifyProfile(userDataDir, profile)) || !(await revalidateUnusedProof())) {
      return false;
    }
    try {
      await rm(path.join(profile.canonicalPath, staleFile), { force: true });
    } catch {
      cleaned = false;
    }
  }
  if (!(await verifyProfile(userDataDir, profile)) || !(await revalidateUnusedProof())) {
    return false;
  }
  logger?.("Cleaned up stale Chrome profile locks and owner authority");
  return cleaned;
}
