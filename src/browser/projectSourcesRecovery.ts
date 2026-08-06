import type { BigIntStats } from "node:fs";
import { lstat, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { syncDirectory, syncDirectoryIfPresent } from "../fsDurability.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { getOracleHomeDir } from "../oracleHome.js";
import {
  type BrowserRecoveryTargetCloseCapabilityMetadata,
  type BrowserRuntimeMetadata,
  writeFileAtomicDurable,
} from "../sessionManager.js";
import type { BrowserLogger } from "./types.js";
import {
  captureProfileDirectoryIdentity,
  parseChromeProcessLaunchClaim,
  parseProfileDirectoryIdentity,
  sameChromeProcessLaunchClaim,
  sameProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
} from "./profileState.js";
import { retryBrowserRecoveryCleanup } from "./reattach.js";
import {
  closeChromeTargetWithRetainedCapability,
  isBrowserRecoveryTargetCloseCapability,
  type RetainedTargetCloseCapabilityResult,
} from "./targetCloseAuthority.js";

const PROJECT_SOURCES_CLEANUP_JOURNAL = "project-sources-cleanup.json";

export interface ProjectSourcesCleanupStorage {
  readonly requestedRoot: string;
  readonly root: ProfileDirectoryIdentity;
  readonly journalPath: string;
  readonly lockPath: string;
}

export interface ProjectSourcesProfileCreateIntent {
  readonly generationId: string;
  readonly parent: ProfileDirectoryIdentity;
  readonly userDataDir: string;
}

export interface ProjectSourcesCleanupJournal {
  version: 1;
  oracleHome: ProfileDirectoryIdentity;
  runtime?: BrowserRuntimeMetadata;
  profileCreate?: ProjectSourcesProfileCreateIntent;
}

export async function establishProjectSourcesCleanupStorage(): Promise<ProjectSourcesCleanupStorage> {
  const requestedRoot = path.resolve(getOracleHomeDir());
  const root = await captureProfileDirectoryIdentity(requestedRoot, { create: true });
  const journalPath = path.join(root.canonicalPath, PROJECT_SOURCES_CLEANUP_JOURNAL);
  return { requestedRoot, root, journalPath, lockPath: `${journalPath}.lock` };
}

export async function assertProjectSourcesCleanupStorage(
  storage: ProjectSourcesCleanupStorage,
): Promise<void> {
  if (path.resolve(getOracleHomeDir()) !== storage.requestedRoot) {
    throw new Error("Project Sources cleanup Oracle-home root changed during the operation.");
  }
  const current = await captureProfileDirectoryIdentity(storage.requestedRoot);
  if (!sameProfileDirectoryIdentity(current, storage.root)) {
    throw new Error("Project Sources cleanup Oracle-home physical authority changed.");
  }
}

export function projectSourcesCleanupJournalPath(): string {
  return path.join(getOracleHomeDir(), PROJECT_SOURCES_CLEANUP_JOURNAL);
}

function hasProjectSourcesCleanupAuthority(runtime: BrowserRuntimeMetadata): boolean {
  return Boolean(runtime.recoveryCleanupResources?.length && runtime.recoveryCleanupResult);
}

function isProjectSourcesProfileCreateIntent(
  value: unknown,
): value is ProjectSourcesProfileCreateIntent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const parent = parseProfileDirectoryIdentity(candidate.parent, process.platform);
  return Boolean(
    parent &&
    typeof candidate.generationId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      candidate.generationId,
    ) &&
    typeof candidate.userDataDir === "string" &&
    path.resolve(candidate.userDataDir) ===
      path.join(parent.canonicalPath, `oracle-browser-${candidate.generationId}`),
  );
}

export function projectSourcesProfileQuarantinePath(
  intent: ProjectSourcesProfileCreateIntent,
): string {
  return path.join(
    intent.parent.canonicalPath,
    `.oracle-browser-${intent.generationId}.identity-unknown`,
  );
}

export async function assertProjectSourcesProfileParent(
  intent: ProjectSourcesProfileCreateIntent,
): Promise<void> {
  const current = await captureProfileDirectoryIdentity(intent.parent.canonicalPath);
  if (!sameProfileDirectoryIdentity(current, intent.parent)) {
    throw new Error("Project Sources temporary profile parent authority changed before recovery.");
  }
}

async function lstatProjectSourcesEntry(candidate: string) {
  try {
    return await lstat(candidate, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameProjectSourcesEntryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.mode === right.mode
  );
}

function hasOwnedProjectSourcesProvenance(runtime: BrowserRuntimeMetadata): boolean {
  return Boolean(
    runtime.recoveryCleanupResources?.every((resource) => {
      const acquisition = resource.acquisition;
      const launchClaim = parseChromeProcessLaunchClaim(acquisition?.processLaunchClaim);
      const profile = parseProfileDirectoryIdentity(
        resource.profileDirectoryIdentity,
        process.platform,
      );
      if (
        !acquisition?.generationId ||
        !launchClaim ||
        launchClaim.generationId !== acquisition.generationId ||
        !acquisition.processOwnerDisposition ||
        !profile ||
        (resource.recoveryCleanup.profileKind === "temporary" &&
          acquisition.processOwnerProvenance !== "temporary-launch") ||
        (resource.recoveryCleanup.profileKind === "manual-login" &&
          acquisition.processOwnerProvenance !== "manual-canonical-owner") ||
        !["temporary", "manual-login"].includes(resource.recoveryCleanup.profileKind)
      ) {
        return false;
      }
      if (
        resource.chromeProcessIdentity &&
        (!sameProfileDirectoryIdentity(resource.chromeProcessIdentity.profileDirectory, profile) ||
          (resource.recoveryCleanup.profileKind === "temporary" &&
            !sameChromeProcessLaunchClaim(resource.chromeProcessIdentity.launchClaim, launchClaim)))
      ) {
        return false;
      }
      if (
        resource.tabLease &&
        !sameProfileDirectoryIdentity(resource.tabLease.profileDirectory, profile)
      ) {
        return false;
      }
      if (acquisition.pendingResource) return true;
      if (resource.recoveryCleanup.ownsTarget) {
        return Boolean(
          resource.chromeTargetId &&
          resource.targetCloseCapability?.generationId === acquisition.generationId &&
          resource.targetCloseCapability.capabilityId &&
          resource.acquisition?.targetMarkerUrl ===
            `about:blank#oracle-project-sources=${acquisition.generationId}`,
        );
      }
      return true;
    }),
  );
}

function isProjectSourcesCleanupJournal(value: unknown): value is ProjectSourcesCleanupJournal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const root = parseProfileDirectoryIdentity(candidate.oracleHome, process.platform);
  const runtime = candidate.runtime as BrowserRuntimeMetadata | undefined;
  const profileCreate = candidate.profileCreate;
  return (
    candidate.version === 1 &&
    Boolean(root) &&
    ((Boolean(runtime) &&
      hasProjectSourcesCleanupAuthority(runtime as BrowserRuntimeMetadata) &&
      hasOwnedProjectSourcesProvenance(runtime as BrowserRuntimeMetadata) &&
      !profileCreate) ||
      (!runtime && isProjectSourcesProfileCreateIntent(profileCreate)))
  );
}

export async function readProjectSourcesCleanupJournal(
  storage?: ProjectSourcesCleanupStorage,
): Promise<ProjectSourcesCleanupJournal | null> {
  const resolvedStorage = storage ?? (await establishProjectSourcesCleanupStorage());
  await assertProjectSourcesCleanupStorage(resolvedStorage);
  try {
    const parsed: unknown = JSON.parse(await readFile(resolvedStorage.journalPath, "utf8"));
    if (!isProjectSourcesCleanupJournal(parsed)) {
      throw new Error(`Project Sources cleanup journal is invalid: ${resolvedStorage.journalPath}`);
    }
    if (!sameProfileDirectoryIdentity(parsed.oracleHome, resolvedStorage.root)) {
      throw new Error("Project Sources cleanup journal Oracle-home authority does not match.");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function persistProjectSourcesCleanupRuntime(
  runtime: BrowserRuntimeMetadata,
  storage?: ProjectSourcesCleanupStorage,
  profileCreate?: ProjectSourcesProfileCreateIntent,
): Promise<void> {
  const resolvedStorage = storage ?? (await establishProjectSourcesCleanupStorage());
  await assertProjectSourcesCleanupStorage(resolvedStorage);
  if (hasProjectSourcesCleanupAuthority(runtime) || profileCreate) {
    await writeFileAtomicDurable(
      resolvedStorage.journalPath,
      `${JSON.stringify(
        {
          version: 1,
          oracleHome: resolvedStorage.root,
          ...(profileCreate ? { profileCreate } : { runtime }),
        } satisfies ProjectSourcesCleanupJournal,
        null,
        2,
      )}\n`,
    );
    return;
  }
  await rm(resolvedStorage.journalPath, { force: true });
  await syncDirectoryIfPresent(path.dirname(resolvedStorage.journalPath));
}

function ownedProjectSourcesTarget(
  runtime: BrowserRuntimeMetadata,
  capability: BrowserRecoveryTargetCloseCapabilityMetadata,
  targetId: string,
) {
  return runtime.recoveryCleanupResources?.find(
    (resource) =>
      resource.recoveryCleanup.ownsTarget === true &&
      resource.chromeTargetId === targetId &&
      resource.acquisition?.generationId === capability.generationId &&
      resource.acquisition.targetMarkerUrl ===
        `about:blank#oracle-project-sources=${capability.generationId}` &&
      resource.targetCloseCapability?.generationId === capability.generationId &&
      resource.targetCloseCapability.capabilityId === capability.capabilityId,
  );
}

export async function closeProjectSourcesTargetFromJournal(options: {
  ownerId: string;
  runtime: BrowserRuntimeMetadata;
  capability: BrowserRecoveryTargetCloseCapabilityMetadata;
  targetId: string;
  logger: BrowserLogger;
}): Promise<RetainedTargetCloseCapabilityResult> {
  const { ownerId, runtime, capability, targetId, logger } = options;
  if (!isBrowserRecoveryTargetCloseCapability(capability)) {
    return {
      status: "unavailable",
      reason: "Project Sources target cleanup capability is malformed",
    };
  }
  if (!ownedProjectSourcesTarget(runtime, capability, targetId)) {
    return {
      status: "unavailable",
      reason: "Project Sources cleanup target does not match its durable generation authority",
    };
  }
  return await closeChromeTargetWithRetainedCapability({ ownerId, capability, targetId, logger });
}

export async function recoverPendingProjectSourcesProfileCreate(
  journal: ProjectSourcesCleanupJournal,
  storage: ProjectSourcesCleanupStorage,
  logger: BrowserLogger,
): Promise<boolean> {
  const intent = journal.profileCreate;
  if (!intent) return false;
  await assertProjectSourcesProfileParent(intent);

  const quarantinePath = projectSourcesProfileQuarantinePath(intent);
  const occupant = await lstatProjectSourcesEntry(intent.userDataDir);
  if (!occupant) {
    const quarantinedOccupant = await lstatProjectSourcesEntry(quarantinePath);
    await assertProjectSourcesProfileParent(intent);
    if (quarantinedOccupant) {
      logger(
        `[browser] Project Sources preserved an identity-less temporary profile at ${quarantinePath} for manual inspection.`,
      );
    }
    await persistProjectSourcesCleanupRuntime({}, storage);
    return true;
  }

  if (await lstatProjectSourcesEntry(quarantinePath)) {
    throw new Error(
      `Project Sources temporary profile and its quarantine path are both occupied; preserving both for manual recovery: ${intent.userDataDir}, ${quarantinePath}`,
    );
  }
  await assertProjectSourcesProfileParent(intent);
  try {
    await rename(intent.userDataDir, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const quarantinedOccupant = await lstatProjectSourcesEntry(quarantinePath);
    await assertProjectSourcesProfileParent(intent);
    if (!quarantinedOccupant) {
      await persistProjectSourcesCleanupRuntime({}, storage);
      return true;
    }
  }
  await syncDirectory(intent.parent.canonicalPath);
  const quarantinedOccupant = await lstatProjectSourcesEntry(quarantinePath);
  await assertProjectSourcesProfileParent(intent);
  if (!quarantinedOccupant || !sameProjectSourcesEntryIdentity(occupant, quarantinedOccupant)) {
    throw new Error(
      `Project Sources temporary profile quarantine identity changed; preserving the journal and occupant for manual recovery: ${quarantinePath}`,
    );
  }
  logger(
    `[browser] Project Sources preserved an identity-less temporary profile at ${quarantinePath} for manual inspection.`,
  );
  await persistProjectSourcesCleanupRuntime({}, storage);
  return true;
}

function bindProjectSourcesAbortRecovery(runtime: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
  return {
    ...runtime,
    recoveryCleanupResult: { status: "pending", settlementMode: "abort" },
  };
}

export async function reconcilePendingProjectSourcesTarget(
  runtime: BrowserRuntimeMetadata,
  _logger: BrowserLogger,
): Promise<BrowserRuntimeMetadata> {
  const pendingResources = runtime.recoveryCleanupResources?.filter(
    (candidate) => candidate.acquisition?.pendingResource === "chrome-target",
  );
  if (!pendingResources?.length) return runtime;
  if (pendingResources.length !== 1) {
    throw new Error(
      "Project Sources interrupted target acquisition names multiple pending resources.",
    );
  }
  return runtime;
}

export async function retryPendingProjectSourcesCleanup(
  logger: BrowserLogger,
  storage: ProjectSourcesCleanupStorage | undefined,
  ownerId: string,
): Promise<void> {
  const resolvedStorage = storage ?? (await establishProjectSourcesCleanupStorage());
  const journal = await readProjectSourcesCleanupJournal(resolvedStorage);
  if (
    !journal ||
    (await recoverPendingProjectSourcesProfileCreate(journal, resolvedStorage, logger))
  )
    return;
  if (!journal.runtime)
    throw new Error("Project Sources cleanup journal has no runtime authority.");
  const abortRuntime = bindProjectSourcesAbortRecovery(journal.runtime);
  await persistProjectSourcesCleanupRuntime(abortRuntime, resolvedStorage);
  const runtime = await reconcilePendingProjectSourcesTarget(abortRuntime, logger);
  if (runtime !== abortRuntime) {
    await persistProjectSourcesCleanupRuntime(runtime, resolvedStorage);
  }
  const finalization = await retryBrowserRecoveryCleanup(
    runtime,
    logger,
    {
      ownerId,
      recoveryCleanup: {
        closeChromeTargetWithRetainedCapability: ({ capability, targetId, logger: closeLogger }) =>
          closeProjectSourcesTargetFromJournal({
            ownerId,
            runtime,
            capability,
            targetId,
            logger: closeLogger,
          }),
      },
      persistFinalizationResult: async (result) => {
        await persistProjectSourcesCleanupRuntime(result.runtime, resolvedStorage);
        return result;
      },
    },
    "abort",
  );
  if (finalization.status === "pending") {
    throw new BrowserAutomationError(
      `Project Sources browser cleanup remains retryable and is durably journaled for the next Project Sources run: ${finalization.error}`,
      { stage: "project-sources-cleanup", runtime: finalization.runtime },
    );
  }
}
