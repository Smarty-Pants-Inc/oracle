import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import {
  acquireCrashRecoverableFilesystemLock,
  type CrashRecoverableFilesystemLock,
  FilesystemLockBusyError,
} from "./filesystemLock.js";
import {
  isolateDirectoryGenerationForRemoval,
  removeIsolatedDirectoryGeneration,
  replayPendingIsolatedDirectoryRemovals,
} from "./filesystemLockPrimitives.js";
import {
  assertProfileDirectoryIdentity,
  captureProfileDirectoryIdentity,
  sameProfileDirectoryIdentity,
  verifyProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
  type ProfileStateLogger,
} from "./profileDirectoryAuthority.js";
import { getDevToolsActivePortPaths } from "./profileDevToolsState.js";
import {
  inspectChromeProcessIdentityWithDeps,
  isChromeUsingUserDataDir,
  isProcessAlive,
  parseChromeProcessIdentity,
  sameChromeProcessIdentity,
  type ChromeProcessIdentity,
  type ChromeProcessIdentityDeps,
} from "./chromeProcessIdentity.js";

export * from "./profileDirectoryAuthority.js";
export * from "./profileDevToolsState.js";
export * from "./chromeProcessIdentity.js";

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

export interface OracleChromeOwnerRecord {
  readonly port: number;
  readonly processIdentity: ChromeProcessIdentity;
  readonly disposition: ChromeOwnerDisposition;
}

interface RemoveProfileDirectoryDeps {
  isChromeUsingUserDataDir?: (userDataDir: string) => Promise<boolean>;
  beforeQuarantineRename?: () => void | Promise<void>;
  beforeQuarantineDelete?: (quarantinePath: string) => void | Promise<void>;
  afterQuarantineIdentityVerification?: (quarantinePath: string) => void | Promise<void>;
  afterRemovalChildAttestation?: (isolatedRootPath: string) => void | Promise<void>;
}

export async function removeProfileDirectoryIfIdentityMatches(
  userDataDir: string,
  expected: ProfileDirectoryIdentity,
): Promise<boolean> {
  return removeProfileDirectoryIfIdentityMatchesWithDeps(userDataDir, expected, {});
}

export async function removeProfileDirectoryIfIdentityMatchesForTest(
  userDataDir: string,
  expected: ProfileDirectoryIdentity,
  deps: RemoveProfileDirectoryDeps,
): Promise<boolean> {
  return removeProfileDirectoryIfIdentityMatchesWithDeps(userDataDir, expected, deps);
}

export async function replayPendingProfileDirectoryRemovals(userDataDir: string): Promise<void> {
  const canonicalPath = await canonicalProfileRemovalPath(userDataDir);
  if (canonicalPath === null) return;
  await replayPendingIsolatedDirectoryRemovals(path.dirname(canonicalPath), canonicalPath);
}

async function removeProfileDirectoryIfIdentityMatchesWithDeps(
  userDataDir: string,
  expected: ProfileDirectoryIdentity,
  deps: RemoveProfileDirectoryDeps,
): Promise<boolean> {
  if (!(await pathExists(expected.canonicalPath))) return true;
  if (!(await verifyProfileDirectoryIdentity(userDataDir, expected))) return false;
  const profileInUse = deps.isChromeUsingUserDataDir ?? isChromeUsingUserDataDir;
  if (await profileInUse(expected.canonicalPath)) return false;
  if (!(await verifyProfileDirectoryIdentity(userDataDir, expected))) return false;
  await deps.beforeQuarantineRename?.();

  const quarantinePath = path.join(
    path.dirname(expected.canonicalPath),
    `.${path.basename(expected.canonicalPath)}.oracle-delete-${process.pid}-${randomUUID()}`,
  );
  try {
    await rename(expected.canonicalPath, quarantinePath);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(String(readErrorCode(error)))) return false;
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
  if (!(await verifyProfileDirectoryIdentity(quarantinePath, quarantinedIdentity))) {
    await restore();
    return false;
  }
  if (await profileInUse(expected.canonicalPath)) {
    await restore();
    return false;
  }

  await deps.beforeQuarantineDelete?.(quarantinePath);
  if (!(await verifyProfileDirectoryIdentity(quarantinePath, quarantinedIdentity))) return false;
  await deps.afterQuarantineIdentityVerification?.(quarantinePath);
  const isolation = await isolateDirectoryGenerationForRemoval(
    quarantinePath,
    async (generationPath) =>
      verifyProfileDirectoryIdentity(
        generationPath,
        Object.freeze({ ...expected, canonicalPath: path.resolve(generationPath) }),
      ),
    expected.canonicalPath,
  );
  if (isolation.status !== "isolated") return false;
  await removeIsolatedDirectoryGeneration(isolation.rootPath, {
    afterChildAttestation: deps.afterRemovalChildAttestation,
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

export async function verifyChromeProcessIdentity(
  userDataDir: string,
  identity: ChromeProcessIdentity,
): Promise<boolean> {
  return verifyChromeProcessIdentityWithDeps(userDataDir, identity, {});
}

export async function verifyChromeProcessIdentityForTest(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  deps: ChromeProcessIdentityDeps,
): Promise<boolean> {
  return verifyChromeProcessIdentityWithDeps(userDataDir, identity, deps);
}

async function verifyChromeProcessIdentityWithDeps(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  deps: ChromeProcessIdentityDeps,
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

function parseOracleChromeOwnerRecord(
  value: unknown,
  platform: NodeJS.Platform,
): OracleChromeOwnerRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    !Object.hasOwn(record, "port") ||
    !Object.hasOwn(record, "processIdentity") ||
    Object.keys(record).some(
      (key) => key !== "port" && key !== "processIdentity" && key !== "disposition",
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
  const processIdentity = parseChromeProcessIdentity(record.processIdentity, platform);
  if (!processIdentity || !disposition) return null;
  return Object.freeze({
    port: record.port as number,
    processIdentity,
    disposition,
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

function readErrorCode(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return error.code;
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

interface RecordedChromeTerminationDeps extends ChromeProcessIdentityDeps {
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
    filesystemLock = await acquireCrashRecoverableFilesystemLock(lockPath, {
      timeoutMs,
      pollMs,
      createParent: false,
      sessionId: options.sessionId,
    });
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

interface CleanupStaleProfileStateDeps {
  captureProfileIdentity?: typeof captureProfileDirectoryIdentity;
  verifyProfileIdentity?: typeof verifyProfileDirectoryIdentity;
  isChromeUsingUserDataDir?: typeof isChromeUsingUserDataDir;
  beforeDestructiveCleanup?: () => void | Promise<void>;
}

export async function cleanupStaleProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: {
    lockRemovalMode?: "never" | "if_oracle_pid_dead";
    expectedProfileIdentity?: ProfileDirectoryIdentity;
  } = {},
): Promise<boolean> {
  return cleanupStaleProfileStateWithDeps(userDataDir, logger, options, {});
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
  try {
    await replayPendingProfileDirectoryRemovals(userDataDir);
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
    profile = options.expectedProfileIdentity ?? (await captureProfile(userDataDir));
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
  if (await (deps.isChromeUsingUserDataDir ?? isChromeUsingUserDataDir)(profile.canonicalPath)) {
    logger?.("Detected running Chrome using this profile; preserving profile state");
    return false;
  }
  await deps.beforeDestructiveCleanup?.();

  let cleaned = true;
  for (const candidate of getDevToolsActivePortPaths(profile.canonicalPath)) {
    if (!(await verifyProfile(userDataDir, profile))) return false;
    try {
      await rm(candidate, { force: true });
      logger?.(`Removed stale DevToolsActivePort: ${candidate}`);
    } catch {
      cleaned = false;
    }
  }
  if (lockRemovalMode === "never") {
    return cleaned && (await verifyProfile(userDataDir, profile));
  }

  const staleFiles = [
    "lockfile",
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    ORACLE_CHROME_OWNER_FILENAME,
  ];
  for (const staleFile of staleFiles) {
    if (!(await verifyProfile(userDataDir, profile))) return false;
    try {
      await rm(path.join(profile.canonicalPath, staleFile), { force: true });
    } catch {
      cleaned = false;
    }
  }
  if (!(await verifyProfile(userDataDir, profile))) return false;
  logger?.("Cleaned up stale Chrome profile locks and owner authority");
  return cleaned;
}
