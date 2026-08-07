import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { syncDirectory, syncDirectoryIfPresent } from "../fsDurability.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { getOracleHomeDir } from "../oracleHome.js";
import {
  assertPrivateDirectoryAuthority,
  establishPrivateRuntimeAuthority,
  removeTemporaryProfileAuthority,
} from "../privateTempRoot.js";
import type { WindowsPrivateDirectoryAuthority } from "../windowsPrivateFileAcl.js";
import {
  type BrowserRecoveryTargetCloseCapabilityMetadata,
  type BrowserRuntimeMetadata,
  writeFileAtomicDurable,
} from "../sessionManager.js";
import {
  assertProjectSourcesCleanupProof,
  assertProjectSourcesProfileParent,
  assertProjectSourcesTemporaryProof,
  authenticateProjectSourcesTemporaryMarker,
  hasOwnedProjectSourcesProvenance,
  hasProjectSourcesCleanupAuthority,
  isProjectSourcesProfileCreateIntent,
  parseProjectSourcesCleanupProof,
  projectSourcesCleanupOwnerId,
  transitionProjectSourcesCleanupProof,
  type ProjectSourcesCleanupProof,
  type ProjectSourcesCleanupStorage,
  type ProjectSourcesProfileCreateIntent,
} from "./projectSourcesCleanupAuthority.js";
import {
  reconcilePendingProjectSourcesManualAcquisition,
  reconcilePendingProjectSourcesTarget,
  type ProjectSourcesPendingTargetDeps,
} from "./projectSourcesPendingTarget.js";
import {
  captureProfileDirectoryIdentity,
  parseProfileDirectoryIdentity,
  sameProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
} from "./profileState.js";
import { retryBrowserRecoveryCleanup } from "./reattach.js";
import {
  closeChromeTargetWithRetainedCapability,
  isBrowserRecoveryTargetCloseCapability,
  type RetainedTargetCloseCapabilityResult,
} from "./targetCloseAuthority.js";
import type { BrowserLogger } from "./types.js";

export {
  assertProjectSourcesCleanupProof,
  assertProjectSourcesProfileParent,
  assertProjectSourcesTemporaryProof,
  createProjectSourcesManualCleanupProof,
  createProjectSourcesProfileCreateIntent,
  createProjectSourcesTemporaryCleanupProof,
  transitionProjectSourcesCleanupProof,
  projectSourcesCleanupOwnerId,
  type ProjectSourcesCleanupProof,
  type ProjectSourcesCleanupProofTransition,
  type ProjectSourcesCleanupStorage,
  type ProjectSourcesManualCleanupProof,
  type ProjectSourcesProfileCreateIntent,
  type ProjectSourcesTemporaryCleanupProof,
} from "./projectSourcesCleanupAuthority.js";
export { reconcilePendingProjectSourcesTarget } from "./projectSourcesPendingTarget.js";

const PROJECT_SOURCES_CLEANUP_JOURNAL = "project-sources-cleanup.json";

export interface ProjectSourcesCleanupJournal {
  version: 2;
  oracleHome: ProfileDirectoryIdentity;
  runtime?: BrowserRuntimeMetadata;
  proof?: ProjectSourcesCleanupProof;
  profileCreate?: ProjectSourcesProfileCreateIntent;
}

export interface ProjectSourcesRecoveryDeps extends ProjectSourcesPendingTargetDeps {
  retryCleanup?: typeof retryBrowserRecoveryCleanup;
}
export interface ProjectSourcesCleanupStorageOptions {
  readonly windowsPrivateDirectoryAuthority?: WindowsPrivateDirectoryAuthority;
}

export async function establishProjectSourcesCleanupStorage(
  oracleHomeDirectory = getOracleHomeDir(),
  options: ProjectSourcesCleanupStorageOptions = {},
): Promise<ProjectSourcesCleanupStorage> {
  const requestedRoot = path.resolve(oracleHomeDirectory);
  const root = await captureProfileDirectoryIdentity(requestedRoot, { create: true });
  const runtimeRoot = await establishPrivateRuntimeAuthority({
    oracleStateDirectory: requestedRoot,
    windowsPrivateDirectoryAuthority: options.windowsPrivateDirectoryAuthority,
  });
  const journalPath = path.join(root.canonicalPath, PROJECT_SOURCES_CLEANUP_JOURNAL);
  return {
    requestedRoot,
    root,
    runtimeRoot,
    windowsPrivateDirectoryAuthority: options.windowsPrivateDirectoryAuthority,
    journalPath,
    lockPath: path.join(runtimeRoot.path, "project-sources-recovery.lock"),
  };
}

export async function assertProjectSourcesCleanupStorage(
  storage: ProjectSourcesCleanupStorage,
): Promise<void> {
  const current = await captureProfileDirectoryIdentity(storage.requestedRoot);
  if (!sameProfileDirectoryIdentity(current, storage.root)) {
    throw new Error("Project Sources cleanup Oracle-home physical authority changed.");
  }
  await assertPrivateDirectoryAuthority(storage.runtimeRoot, {
    windowsPrivateDirectoryAuthority: storage.windowsPrivateDirectoryAuthority,
  });
}

export function projectSourcesCleanupJournalPath(oracleHomeDirectory = getOracleHomeDir()): string {
  return path.join(oracleHomeDirectory, PROJECT_SOURCES_CLEANUP_JOURNAL);
}

function isProjectSourcesCleanupJournal(value: unknown): value is ProjectSourcesCleanupJournal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const root = parseProfileDirectoryIdentity(candidate.oracleHome, process.platform);
  const runtime = candidate.runtime as BrowserRuntimeMetadata | undefined;
  const proof = parseProjectSourcesCleanupProof(candidate.proof);
  const profileCreate = candidate.profileCreate;
  return Boolean(
    candidate.version === 2 &&
    root &&
    ((runtime &&
      proof &&
      hasProjectSourcesCleanupAuthority(runtime) &&
      hasOwnedProjectSourcesProvenance(runtime, proof) &&
      !profileCreate) ||
      (!runtime && !proof && isProjectSourcesProfileCreateIntent(profileCreate))),
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
    const ownerId = projectSourcesCleanupOwnerId(resolvedStorage);
    if (parsed.proof && parsed.proof.storageOwnerId !== ownerId) {
      throw new Error("Project Sources cleanup proof is bound to different cleanup storage.");
    }
    if (parsed.profileCreate && parsed.profileCreate.storageOwnerId !== ownerId) {
      throw new Error(
        "Project Sources profile creation intent is bound to different cleanup storage.",
      );
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
  authority: {
    proof?: ProjectSourcesCleanupProof;
    profileCreate?: ProjectSourcesProfileCreateIntent;
  } = {},
): Promise<void> {
  const resolvedStorage = storage ?? (await establishProjectSourcesCleanupStorage());
  await assertProjectSourcesCleanupStorage(resolvedStorage);
  if (hasProjectSourcesCleanupAuthority(runtime)) {
    if (!authority.proof || !hasOwnedProjectSourcesProvenance(runtime, authority.proof)) {
      throw new Error("Project Sources cleanup runtime has no exact Project Sources proof.");
    }
    await writeFileAtomicDurable(
      resolvedStorage.journalPath,
      `${JSON.stringify(
        { version: 2, oracleHome: resolvedStorage.root, runtime, proof: authority.proof },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (authority.profileCreate) {
    if (!isProjectSourcesProfileCreateIntent(authority.profileCreate)) {
      throw new Error("Project Sources profile creation intent is invalid.");
    }
    await writeFileAtomicDurable(
      resolvedStorage.journalPath,
      `${JSON.stringify(
        { version: 2, oracleHome: resolvedStorage.root, profileCreate: authority.profileCreate },
        null,
        2,
      )}\n`,
    );
    return;
  }
  await rm(resolvedStorage.journalPath, { force: true });
  await syncDirectoryIfPresent(path.dirname(resolvedStorage.journalPath));
}

/**
 * Retire the cleanup journal before its manual-admission receipt.  If journal
 * retirement is not durable, restore the exact retry authority before returning.
 */
export async function retireProjectSourcesCleanupJournal(
  runtime: BrowserRuntimeMetadata,
  proof: ProjectSourcesCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  logger: BrowserLogger,
): Promise<void> {
  try {
    await persistProjectSourcesCleanupRuntime({}, storage);
  } catch (retirementError) {
    try {
      await persistProjectSourcesCleanupRuntime(runtime, storage, { proof });
    } catch (restoreError) {
      throw new AggregateError(
        [retirementError, restoreError],
        "Project Sources cleanup journal retirement failed and retry authority could not be restored.",
      );
    }
    throw retirementError;
  }
  try {
    await transitionProjectSourcesCleanupProof(proof, storage, { type: "remove-artifacts" });
  } catch (error) {
    logger(
      `[browser] Project Sources cleanup journal retired; retained its admission receipt after removal failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function ownedProjectSourcesTarget(
  runtime: BrowserRuntimeMetadata,
  proof: ProjectSourcesCleanupProof,
  capability: BrowserRecoveryTargetCloseCapabilityMetadata,
  targetId: string,
) {
  return runtime.recoveryCleanupResources?.find(
    (resource) =>
      resource.recoveryCleanup.ownsTarget === true &&
      resource.chromeTargetId === targetId &&
      resource.acquisition?.generationId === proof.generationId &&
      capability.generationId === proof.generationId &&
      resource.acquisition.targetMarkerUrl ===
        `about:blank#oracle-project-sources=${proof.generationId}` &&
      resource.targetCloseCapability?.generationId === proof.generationId &&
      resource.targetCloseCapability.capabilityId === capability.capabilityId,
  );
}

export async function closeProjectSourcesTargetFromJournal(options: {
  ownerId: string;
  runtime: BrowserRuntimeMetadata;
  proof: ProjectSourcesCleanupProof;
  storage: ProjectSourcesCleanupStorage;
  capability: BrowserRecoveryTargetCloseCapabilityMetadata;
  targetId: string;
  logger: BrowserLogger;
  deps?: ProjectSourcesRecoveryDeps;
}): Promise<RetainedTargetCloseCapabilityResult> {
  const { ownerId, runtime, proof, storage, capability, targetId, logger, deps = {} } = options;
  if (ownerId !== proof.storageOwnerId) {
    return {
      status: "unavailable",
      reason: "Project Sources target cleanup does not match this storage owner",
    };
  }
  if (!isBrowserRecoveryTargetCloseCapability(capability)) {
    return {
      status: "unavailable",
      reason: "Project Sources target cleanup capability is malformed",
    };
  }
  if (!ownedProjectSourcesTarget(runtime, proof, capability, targetId)) {
    return {
      status: "unavailable",
      reason: "Project Sources cleanup target does not match its durable generation authority",
    };
  }
  try {
    await assertProjectSourcesCleanupProof(runtime, proof, storage, deps);
  } catch (error) {
    return {
      status: "unavailable",
      reason: `Project Sources target cleanup proof is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return await closeChromeTargetWithRetainedCapability({ ownerId, capability, targetId, logger });
}

async function projectSourcesEntryExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate, { bigint: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function recoverPendingProjectSourcesProfileCreate(
  journal: ProjectSourcesCleanupJournal,
  storage: ProjectSourcesCleanupStorage,
  logger: BrowserLogger,
): Promise<boolean> {
  const intent = journal.profileCreate;
  if (!intent) return false;
  await assertProjectSourcesProfileParent(intent, storage);
  if (!(await projectSourcesEntryExists(intent.userDataDir))) {
    await persistProjectSourcesCleanupRuntime({}, storage);
    return true;
  }
  if (!intent.temporaryProfileAuthority) {
    throw new Error(
      `Project Sources preserved an unproven temporary-profile occupant for manual recovery: ${intent.userDataDir}`,
    );
  }

  let proof = intent.proof;
  if (proof) {
    await assertProjectSourcesTemporaryProof(proof, storage);
  } else {
    try {
      proof = await authenticateProjectSourcesTemporaryMarker(intent, {
        windowsPrivateDirectoryAuthority: storage.windowsPrivateDirectoryAuthority,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Project Sources preserved an unproven temporary-profile occupant for manual recovery: ${intent.userDataDir}`,
          { cause: error },
        );
      }
      const removedPrivateChild = await removeTemporaryProfileAuthority(
        intent.temporaryProfileAuthority,
        { windowsPrivateDirectoryAuthority: storage.windowsPrivateDirectoryAuthority },
      );
      if (!removedPrivateChild) {
        throw new Error(
          `Project Sources private pre-marker profile removal was not confirmed: ${intent.userDataDir}`,
        );
      }
      await assertPrivateDirectoryAuthority(intent.temporaryProfileAuthority.generation.parent, {
        windowsPrivateDirectoryAuthority: storage.windowsPrivateDirectoryAuthority,
      });
      await persistProjectSourcesCleanupRuntime({}, storage);
      logger(
        `[browser] Removed interrupted Project Sources private profile ${intent.userDataDir}.`,
      );
      return true;
    }
    await persistProjectSourcesCleanupRuntime({}, storage, {
      profileCreate: { ...intent, proof },
    });
  }
  await assertProjectSourcesTemporaryProof(proof, storage);
  const removed = await removeTemporaryProfileAuthority(proof.temporaryProfileAuthority);
  if (!removed) {
    throw new Error(
      `Project Sources proven temporary profile removal was not confirmed: ${intent.userDataDir}`,
    );
  }
  await assertPrivateDirectoryAuthority(proof.temporaryProfileAuthority.generation.parent);
  await syncDirectory(intent.parent.canonicalPath);
  logger(`[browser] Removed interrupted Project Sources temporary profile ${intent.userDataDir}.`);
  await persistProjectSourcesCleanupRuntime({}, storage);
  return true;
}

function bindProjectSourcesAbortRecovery(runtime: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
  return {
    ...runtime,
    recoveryCleanupResult: { status: "pending", settlementMode: "abort" },
  };
}

export async function retryPendingProjectSourcesCleanup(
  logger: BrowserLogger,
  storage?: ProjectSourcesCleanupStorage,
  deps: ProjectSourcesRecoveryDeps = {},
): Promise<void> {
  const resolvedStorage = storage ?? (await establishProjectSourcesCleanupStorage());
  const ownerId = projectSourcesCleanupOwnerId(resolvedStorage);
  const journal = await readProjectSourcesCleanupJournal(resolvedStorage);
  if (
    !journal ||
    (await recoverPendingProjectSourcesProfileCreate(journal, resolvedStorage, logger))
  ) {
    return;
  }
  if (!journal.runtime || !journal.proof) {
    throw new Error("Project Sources cleanup journal has no exact runtime proof.");
  }
  let runtime = bindProjectSourcesAbortRecovery(journal.runtime);
  let proof = journal.proof;
  await persistProjectSourcesCleanupRuntime(runtime, resolvedStorage, { proof });

  const acquisition = await reconcilePendingProjectSourcesManualAcquisition(runtime, proof, deps);
  if (!acquisition) {
    await retireProjectSourcesCleanupJournal(runtime, proof, resolvedStorage, logger);
    return;
  }
  if (acquisition.runtime !== runtime || acquisition.proof !== proof) {
    runtime = acquisition.runtime;
    proof = await transitionProjectSourcesCleanupProof(
      acquisition.proof,
      resolvedStorage,
      { type: "persist", runtime },
      deps,
    );
    await persistProjectSourcesCleanupRuntime(runtime, resolvedStorage, { proof });
  }

  const reconciledTarget = await reconcilePendingProjectSourcesTarget(
    runtime,
    proof,
    resolvedStorage,
    logger,
    deps,
  );
  if (reconciledTarget !== runtime) {
    runtime = reconciledTarget;
    await persistProjectSourcesCleanupRuntime(runtime, resolvedStorage, { proof });
  }
  await assertProjectSourcesCleanupProof(runtime, proof, resolvedStorage, deps);

  const runtimeAuthority = runtime;
  let durableProof = proof;
  let durableRuntime = runtime;
  const finalization = await (deps.retryCleanup ?? retryBrowserRecoveryCleanup)(
    runtime,
    logger,
    {
      ownerId,
      recoveryCleanup: {
        closeChromeTargetWithRetainedCapability: ({ capability, targetId, logger: closeLogger }) =>
          closeProjectSourcesTargetFromJournal({
            ownerId,
            runtime: runtimeAuthority,
            proof: durableProof,
            storage: resolvedStorage,
            capability,
            targetId,
            logger: closeLogger,
            deps,
          }),
        removeProfile: async (profileDir, expectedIdentity) => {
          if (durableProof.kind !== "temporary") return false;
          await assertProjectSourcesTemporaryProof(durableProof, resolvedStorage);
          if (
            durableProof.temporaryProfileAuthority.generation.path !== profileDir ||
            !sameProfileDirectoryIdentity(
              durableProof.temporaryProfileAuthority.profileDirectory,
              expectedIdentity,
            )
          ) {
            return false;
          }
          return await removeTemporaryProfileAuthority(durableProof.temporaryProfileAuthority, {
            windowsPrivateDirectoryAuthority: resolvedStorage.windowsPrivateDirectoryAuthority,
          });
        },
      },
      persistFinalizationResult: async (result) => {
        if (hasProjectSourcesCleanupAuthority(result.runtime)) {
          durableProof = await transitionProjectSourcesCleanupProof(
            durableProof,
            resolvedStorage,
            { type: "persist", runtime: result.runtime },
            deps,
          );
          await persistProjectSourcesCleanupRuntime(result.runtime, resolvedStorage, {
            proof: durableProof,
          });
          durableRuntime = result.runtime;
        } else {
          await retireProjectSourcesCleanupJournal(
            durableRuntime,
            durableProof,
            resolvedStorage,
            logger,
          );
        }
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
