import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  closeChromeTargetWithExactAuthority,
  connectWithNewTabWithExactAuthority,
  launchChrome,
  positionChromeWindowOffscreen,
  registerTerminationHooks,
  retainChromeEndpointAuthority,
  type RetainedChromeEndpointAuthority,
} from "./chromeLifecycle.js";
import { acquireManualChromeOwner } from "./manualChromeOwner.js";
import { resolveBrowserConfig } from "./config.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import { installJavaScriptDialogAutoDismissal, navigateToChatGPT } from "./pageActions.js";
import type { BrowserLogger, ChromeClient, ResolvedBrowserConfig } from "./types.js";
import type {
  BrowserRecoveryTargetCloseCapabilityMetadata,
  BrowserRuntimeMetadata,
} from "../sessionManager.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { LocalOwnedBrowserResourceAuthority } from "./ownedBrowserResources.js";
import { acquireBrowserTabLease, type BrowserTabLease } from "./tabLeaseRegistry.js";
import {
  captureProfileDirectoryIdentity,
  createChromeProcessLaunchClaim,
  parseChromeProcessLaunchClaim,
  parseProfileDirectoryIdentity,
  sameChromeProcessLaunchClaim,
  sameProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
} from "./profileState.js";
import { CHATGPT_URL } from "./constants.js";
import {
  assertManualLoginProfileReadyForRun,
  defaultManualLoginProfileDir,
} from "./manualLoginProfile.js";
import {
  openProjectSourcesTab,
  uploadProjectSources,
  waitForProjectSourcesReady,
  waitForProjectSourcesListSettled,
} from "./actions/projectSources.js";
import { normalizeProjectSourcesUrl } from "../projectSources/url.js";
import { buildProjectSourcesUploadPlan, diffAddedProjectSources } from "../projectSources/plan.js";
import type { ProjectSourcesRequest, ProjectSourcesResult } from "../projectSources/types.js";
import { getOracleHomeDir } from "../oracleHome.js";
import { syncDirectory, syncDirectoryIfPresent } from "../fsDurability.js";
import { writeFileAtomicDurable } from "../sessionManager.js";
import { retryBrowserRecoveryCleanup } from "./reattach.js";
import { acquireReattachRecoveryLock } from "./reattachLock.js";
import { resolveUserDataBaseDir, waitForLogin } from "./localExecutionContext.js";
import { listChromeTargetsWithExactAuthority } from "./chromeTargetConnection.js";
import {
  closeChromeTargetWithRetainedCapability,
  isBrowserRecoveryTargetCloseCapability,
  retainChromeTargetCloseCapability,
  type RetainedTargetCloseCapabilityResult,
} from "./targetCloseAuthority.js";

async function connectOwnedProjectSourcesTarget(
  endpointAuthority: RetainedChromeEndpointAuthority,
  logger: BrowserLogger,
  retries: number,
  targetMarkerUrl = "about:blank",
) {
  return await connectWithNewTabWithExactAuthority(endpointAuthority, logger, targetMarkerUrl, {
    retries,
    retryDelayMs: 500,
  });
}

export const connectOwnedProjectSourcesTargetForTest = connectOwnedProjectSourcesTarget;

const PROJECT_SOURCES_CLEANUP_JOURNAL = "project-sources-cleanup.json";

interface ProjectSourcesCleanupStorage {
  readonly requestedRoot: string;
  readonly root: ProfileDirectoryIdentity;
  readonly journalPath: string;
  readonly lockPath: string;
}
interface ProjectSourcesProfileCreateIntent {
  readonly generationId: string;
  readonly parent: ProfileDirectoryIdentity;
  readonly userDataDir: string;
}

interface ProjectSourcesCleanupJournal {
  version: 1;
  oracleHome: ProfileDirectoryIdentity;
  runtime?: BrowserRuntimeMetadata;
  profileCreate?: ProjectSourcesProfileCreateIntent;
}

async function establishProjectSourcesCleanupStorage(): Promise<ProjectSourcesCleanupStorage> {
  const requestedRoot = path.resolve(getOracleHomeDir());
  const root = await captureProfileDirectoryIdentity(requestedRoot, { create: true });
  const journalPath = path.join(root.canonicalPath, PROJECT_SOURCES_CLEANUP_JOURNAL);
  return { requestedRoot, root, journalPath, lockPath: `${journalPath}.lock` };
}

async function assertProjectSourcesCleanupStorage(
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

function projectSourcesCleanupJournalPath(): string {
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

function projectSourcesProfileQuarantinePath(intent: ProjectSourcesProfileCreateIntent): string {
  return path.join(
    intent.parent.canonicalPath,
    `.oracle-browser-${intent.generationId}.identity-unknown`,
  );
}

async function assertProjectSourcesProfileParent(
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

async function readProjectSourcesCleanupJournal(
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

async function persistProjectSourcesCleanupRuntime(
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

async function inspectProjectSourcesTargetMarker(
  authority: RetainedChromeEndpointAuthority,
  targetId: string,
  marker: string,
) {
  if (!authority.runExactOperation) {
    return {
      status: "unsafe" as const,
      reason: "Exact target inspection authority is unavailable",
    };
  }
  return await authority.runExactOperation(async (browser) => {
    const attached = await browser.Target.attachToTarget({ targetId, flatten: true });
    try {
      const evaluated = (await browser.send(
        "Runtime.evaluate",
        { expression: "window.name", returnByValue: true },
        attached.sessionId,
      )) as { result?: { value?: unknown } };
      return evaluated.result?.value === marker;
    } finally {
      await browser.Target.detachFromTarget({ sessionId: attached.sessionId }).catch(
        () => undefined,
      );
    }
  });
}

async function hasProjectSourcesTargetMarker(
  authority: RetainedChromeEndpointAuthority,
  targetId: string,
  marker: string,
): Promise<boolean> {
  const inspected = await inspectProjectSourcesTargetMarker(authority, targetId, marker);
  return inspected.status === "completed" && inspected.value;
}
async function closeProjectSourcesTargetFromJournal(options: {
  runtime: BrowserRuntimeMetadata;
  capability: BrowserRecoveryTargetCloseCapabilityMetadata;
  targetId: string;
  logger: BrowserLogger;
}): Promise<RetainedTargetCloseCapabilityResult> {
  const { runtime, capability, targetId, logger } = options;
  if (!isBrowserRecoveryTargetCloseCapability(capability)) {
    return {
      status: "unavailable",
      reason: "Project Sources target cleanup capability is malformed",
    };
  }
  const resource = ownedProjectSourcesTarget(runtime, capability, targetId);
  if (!resource) {
    return {
      status: "unavailable",
      reason: "Project Sources cleanup target does not match its durable generation authority",
    };
  }
  const live = await closeChromeTargetWithRetainedCapability({ capability, targetId, logger });
  if (live.status !== "unavailable") return live;

  const profileRoot = resource.chromeProfileRoot ?? resource.userDataDir;
  const endpoint = resource.chromeBrowserWSEndpoint;
  const host = resource.chromeHost ?? (endpoint ? new URL(endpoint).hostname : "127.0.0.1");
  const port = resource.chromePort ?? (endpoint ? Number.parseInt(new URL(endpoint).port, 10) : 0);
  if (!profileRoot || !resource.chromeProcessIdentity || !Number.isInteger(port) || port < 1) {
    return {
      status: "unavailable",
      reason: "Project Sources cleanup has no exact Chrome endpoint authority",
    };
  }

  let authority: RetainedChromeEndpointAuthority | undefined;
  let result: RetainedTargetCloseCapabilityResult;
  try {
    authority = await retainChromeEndpointAuthority({
      host,
      port,
      ...(endpoint ? { browserWSEndpoint: endpoint } : {}),
      userDataDir: profileRoot,
      processIdentity: resource.chromeProcessIdentity,
    });
    const listed = await listChromeTargetsWithExactAuthority(authority);
    const marker = resource.acquisition?.targetMarkerUrl;
    if (
      listed.status !== "completed" ||
      !marker ||
      !listed.value.some((target) => target.targetId === targetId) ||
      !(await hasProjectSourcesTargetMarker(authority, targetId, marker))
    ) {
      return {
        status: "unsafe",
        reason:
          "Project Sources durable target cleanup refused because the exact target marker was not observed.",
      };
    }
    result = await closeChromeTargetWithExactAuthority({ authority, targetId, logger });
  } catch (error) {
    return {
      status: "unsafe",
      reason: `Project Sources durable target cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (authority) {
      try {
        await authority.release();
      } catch (error) {
        result = {
          status: "unsafe",
          reason: `Project Sources exact Chrome endpoint release failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  }
  return result!;
}

async function recoverPendingProjectSourcesProfileCreate(
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

function clearPendingProjectSourcesTarget(runtime: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
  const resources = runtime.recoveryCleanupResources?.map((resource) => {
    if (resource.acquisition?.pendingResource !== "chrome-target") return resource;
    const { pendingResource: _pendingResource, ...acquisition } = resource.acquisition;
    return {
      ...resource,
      chromeTargetId: undefined,
      targetCloseCapability: undefined,
      acquisition,
      recoveryCleanup: {
        ...resource.recoveryCleanup,
        ownsTarget: false,
        closeOwnedTargetOnComplete: undefined,
      },
    };
  });
  return { ...runtime, chromeTargetId: undefined, recoveryCleanupResources: resources };
}

async function reconcilePendingProjectSourcesTarget(
  runtime: BrowserRuntimeMetadata,
  logger: BrowserLogger,
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
  const resource = pendingResources[0];
  const marker = resource.acquisition?.targetMarkerUrl;
  const profileRoot = resource.chromeProfileRoot ?? resource.userDataDir;
  const endpoint = resource.chromeBrowserWSEndpoint;
  const host = resource.chromeHost ?? (endpoint ? new URL(endpoint).hostname : "127.0.0.1");
  const port = resource.chromePort ?? (endpoint ? Number.parseInt(new URL(endpoint).port, 10) : 0);
  if (
    !marker ||
    !profileRoot ||
    !resource.chromeProcessIdentity ||
    !Number.isInteger(port) ||
    port < 1
  ) {
    throw new Error(
      "Project Sources interrupted target acquisition has no exact endpoint authority.",
    );
  }

  let authority: RetainedChromeEndpointAuthority | undefined;
  try {
    authority = await retainChromeEndpointAuthority({
      host,
      port,
      ...(endpoint ? { browserWSEndpoint: endpoint } : {}),
      userDataDir: profileRoot,
      processIdentity: resource.chromeProcessIdentity,
    });
    const listed = await listChromeTargetsWithExactAuthority(authority);
    if (listed.status === "gone") return clearPendingProjectSourcesTarget(runtime);
    if (listed.status !== "completed") {
      throw new Error(
        `Project Sources interrupted target acquisition could not list the exact endpoint: ${listed.reason}`,
      );
    }
    const candidates: string[] = [];
    for (const target of listed.value) {
      if (!target.targetId || target.type !== "page") continue;
      if (target.url === marker) {
        candidates.push(target.targetId);
        continue;
      }
      const inspected = await inspectProjectSourcesTargetMarker(authority, target.targetId, marker);
      if (inspected.status === "gone") return clearPendingProjectSourcesTarget(runtime);
      if (inspected.status === "unsafe") {
        throw new Error(
          `Project Sources interrupted target acquisition could not inspect the exact endpoint: ${inspected.reason}`,
        );
      }
      if (inspected.value) candidates.push(target.targetId);
    }
    if (candidates.length === 0) return clearPendingProjectSourcesTarget(runtime);
    if (candidates.length !== 1) {
      throw new Error(
        "Project Sources interrupted target acquisition matched multiple generation markers.",
      );
    }
    if (resource.recoveryCleanup.closeOwnedTargetOnComplete === true) {
      const closed = await closeChromeTargetWithExactAuthority({
        authority,
        targetId: candidates[0],
        logger,
      });
      if (closed.status !== "completed" && closed.status !== "gone") {
        throw new Error(
          `Project Sources interrupted target cleanup was not confirmed: ${closed.reason}`,
        );
      }
    }
    return clearPendingProjectSourcesTarget(runtime);
  } finally {
    await authority?.release();
  }
}

async function retryPendingProjectSourcesCleanup(
  logger: BrowserLogger,
  storage?: ProjectSourcesCleanupStorage,
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
      recoveryCleanup: {
        closeChromeTargetWithRetainedCapability: ({ capability, targetId, logger: closeLogger }) =>
          closeProjectSourcesTargetFromJournal({
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

// biome-ignore lint/style/useNamingConvention: focused lifecycle tests need journal visibility
export const __test__ = {
  projectSourcesCleanupJournalPath,
  persistProjectSourcesCleanupRuntime,
  retryPendingProjectSourcesCleanup,
  closeProjectSourcesTargetFromJournal,
  recoverPendingProjectSourcesProfileCreate,
  projectSourcesProfileQuarantinePath,
  reconcilePendingProjectSourcesTarget,
};

export async function runBrowserProjectSources(
  request: ProjectSourcesRequest,
): Promise<ProjectSourcesResult> {
  if (request.dryRun) return await runBrowserProjectSourcesUnlocked(request);
  const storage = await establishProjectSourcesCleanupStorage();
  const recoveryLock = await acquireReattachRecoveryLock(storage.lockPath);
  try {
    await assertProjectSourcesCleanupStorage(storage);
    return await runBrowserProjectSourcesUnlocked(request, storage);
  } finally {
    await recoveryLock.release();
  }
}

async function runBrowserProjectSourcesUnlocked(
  request: ProjectSourcesRequest,
  storage?: ProjectSourcesCleanupStorage,
): Promise<ProjectSourcesResult> {
  const startedAt = Date.now();
  const logger: BrowserLogger = ((message: string) => request.log?.(message)) as BrowserLogger;
  const projectUrl = normalizeProjectSourcesUrl(request.chatgptUrl);
  const operation = request.operation;
  const files = request.files ?? [];
  const plannedUploads = buildProjectSourcesUploadPlan(files);
  const warnings: string[] = [];
  if (operation === "add" && files.length === 0) {
    throw new Error("Project Sources add requires at least one file.");
  }
  if (request.dryRun) {
    return {
      status: "dry-run",
      operation,
      projectUrl,
      dryRun: true,
      plannedUploads,
      warnings,
      tookMs: Date.now() - startedAt,
    };
  }
  const cleanupStorage = storage ?? (await establishProjectSourcesCleanupStorage());
  await retryPendingProjectSourcesCleanup(logger, cleanupStorage);

  let config = resolveBrowserConfig({
    ...request.config,
    url: projectUrl,
    chatgptUrl: projectUrl,
  });
  if (config.remoteChrome) {
    throw new Error(
      "Project Sources v1 uses local browser automation only. Run it on the signed-in browser host.",
    );
  }

  const manualLogin = Boolean(config.manualLogin);
  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  const targetGenerationId = randomUUID();
  const processLaunchClaim = createChromeProcessLaunchClaim(targetGenerationId);
  const targetMarkerUrl = `about:blank#oracle-project-sources=${targetGenerationId}`;
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : defaultManualLoginProfileDir();
  let profileCreateIntent: ProjectSourcesProfileCreateIntent | undefined;
  let userDataDir = manualLogin ? manualProfileDir : "";
  let profileDirectoryIdentity: ProfileDirectoryIdentity;
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
    logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
    await assertManualLoginProfileReadyForRun({
      userDataDir,
      keepBrowser: effectiveKeepBrowser,
    });
    profileDirectoryIdentity = await captureProfileDirectoryIdentity(userDataDir);
  } else {
    const parent = await captureProfileDirectoryIdentity(await resolveUserDataBaseDir(), {
      create: true,
    });
    const temporaryProfileDir = path.join(
      parent.canonicalPath,
      `oracle-browser-${targetGenerationId}`,
    );
    profileCreateIntent = {
      generationId: targetGenerationId,
      parent,
      userDataDir: temporaryProfileDir,
    };
    await persistProjectSourcesCleanupRuntime({}, cleanupStorage, profileCreateIntent);
    await assertProjectSourcesProfileParent(profileCreateIntent);
    await mkdir(temporaryProfileDir);
    userDataDir = temporaryProfileDir;
    logger(`Created temporary Chrome profile at ${userDataDir}`);
    profileDirectoryIdentity = await captureProfileDirectoryIdentity(userDataDir);
    await assertProjectSourcesProfileParent(profileCreateIntent);
  }

  const leaseId = manualLogin ? randomUUID() : undefined;
  const persistOwnedResources = async (
    runtimeToPersist: BrowserRuntimeMetadata,
  ): Promise<BrowserRuntimeMetadata> => {
    await persistProjectSourcesCleanupRuntime(runtimeToPersist, cleanupStorage);
    return runtimeToPersist;
  };
  const resources = new LocalOwnedBrowserResourceAuthority({
    purpose: "Project Sources",
    targetLabel: "Project Sources",
    userDataDir,
    profileDirectoryIdentity,
    profileKind: manualLogin ? "manual-login" : "temporary",
    keepBrowser: effectiveKeepBrowser,
    closeOwnedTargetOnComplete: !effectiveKeepBrowser,
    generationId: targetGenerationId,
    processOwnerProvenance: manualLogin ? "manual-canonical-owner" : "temporary-launch",
    processLaunchClaim,
    processOwnerDisposition: effectiveKeepBrowser ? "preserve" : "close-on-last-lease",
    ...(leaseId ? { leaseId } : {}),
    targetMarkerUrl,
    tabUrl: projectUrl,
    logger,
    disconnectBeforeTarget: true,
    persistRuntime: persistOwnedResources,
    persistSettlementResult: async (runtimeToPersist) => {
      await persistOwnedResources(runtimeToPersist);
    },
  });
  let removeTerminationHooks: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let completed = false;
  let result: ProjectSourcesResult | undefined;
  let primaryError: unknown;
  try {
    let acquiredTabLease: BrowserTabLease | undefined;
    if (manualLogin) {
      acquiredTabLease = await resources.journalAcquisition({
        resource: "tab-lease",
        acquire: () =>
          acquireBrowserTabLease(userDataDir, {
            maxConcurrentTabs: config.maxConcurrentTabs,
            timeoutMs: config.timeoutMs,
            logger,
            sessionId: "project-sources",
            leaseId,
          }),
        authority: (lease) => lease,
      });
    }
    const acquiredProcess = await resources.journalAcquisition({
      resource: "chrome-process",
      acquire: async () => {
        if (manualLogin) {
          const owner = await acquireManualChromeOwner(
            userDataDir,
            config,
            logger,
            "project-sources",
            { launchClaim: processLaunchClaim },
          );
          return { kind: "manual" as const, owner };
        }
        const chrome = await launchChrome({ ...config, remoteChrome: null }, userDataDir, logger, {
          launchClaim: processLaunchClaim,
        });
        return { kind: "temporary" as const, chrome };
      },
      authority: (authority) => authority,
    });
    const acquiredChrome =
      acquiredProcess.kind === "manual" ? acquiredProcess.owner.chrome : acquiredProcess.chrome;
    const acquiredEndpointAuthority =
      acquiredProcess.kind === "manual"
        ? (acquiredProcess.owner.endpointAuthority ?? acquiredChrome.endpointAuthority)
        : acquiredChrome.endpointAuthority;
    if (!acquiredEndpointAuthority) {
      throw new Error("Project Sources Chrome has no retained exact endpoint authority.");
    }
    const chromeHost = acquiredChrome.host ?? "127.0.0.1";
    if (acquiredTabLease) {
      await acquiredTabLease.update({ chromeHost, chromePort: acquiredChrome.port });
    }

    removeTerminationHooks = registerTerminationHooks(
      acquiredChrome,
      userDataDir,
      effectiveKeepBrowser ||
        (acquiredProcess.kind === "manual" && acquiredProcess.owner.disposition === "preserve"),
      logger,
      {
        isInFlight: () => !completed,
        preserveUserDataDir: manualLogin,
      },
    );

    const devtoolsRetries = manualLogin ? 6 : 0;
    const connection = await resources.journalAcquisition({
      resource: "chrome-target",
      acquire: async () => {
        const opened = await connectOwnedProjectSourcesTarget(
          acquiredEndpointAuthority,
          logger,
          devtoolsRetries,
          targetMarkerUrl,
        );
        if (!opened.targetId) {
          await opened.client.close().catch(() => undefined);
          throw new Error("Project Sources Chrome did not return an exact dedicated target id.");
        }
        await opened.client.Runtime.evaluate({
          expression: `window.name = ${JSON.stringify(targetMarkerUrl)}`,
        });
        return opened;
      },
      authority: (opened) => ({
        targetId: opened.targetId as string,
        releasesProcessEndpointOnSettle: effectiveKeepBrowser,
        capability: retainChromeTargetCloseCapability({
          generationId: targetGenerationId,
          targetId: opened.targetId as string,
          browserWSEndpoint: acquiredEndpointAuthority.browserWSEndpoint,
          close: (closeLogger) =>
            closeChromeTargetWithExactAuthority({
              authority: acquiredEndpointAuthority,
              targetId: opened.targetId as string,
              logger: closeLogger,
            }),
          ...(effectiveKeepBrowser ? { release: () => acquiredEndpointAuthority.release() } : {}),
        }),
        disconnect: () => opened.client.close().catch(() => undefined),
      }),
    });
    const projectClient = connection.client;
    if (acquiredTabLease) {
      await acquiredTabLease.update({
        chromeHost,
        chromePort: acquiredChrome.port,
        chromeTargetId: connection.targetId,
        tabUrl: projectUrl,
      });
    }
    const disconnectPromise = new Promise<never>((_, reject) => {
      projectClient.on("disconnect", () => {
        reject(new Error("Chrome window closed before Project Sources finished."));
      });
    });
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, disconnectPromise]);

    const { Network, Page, Runtime, Input, DOM, Target } = projectClient;
    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    if (!config.headless && config.hideWindow) {
      await positionChromeWindowOffscreen(projectClient, logger);
    }
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
    if (!manualLogin) {
      await Network.clearBrowserCookies();
    }

    const appliedCookies = await applyProjectSourcesCookies({
      config,
      network: Network,
      manualLogin,
      logger,
    });
    await clearStaleChatGptConversationCookies(Network, Target, logger);

    await raceWithDisconnect(navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger));
    await raceWithDisconnect(
      waitForLogin({
        runtime: Runtime,
        logger,
        appliedCookies,
        manualLogin,
        timeoutMs: config.timeoutMs,
        profileDir: userDataDir,
        keepBrowser: effectiveKeepBrowser,
      }),
    );
    await raceWithDisconnect(navigateToChatGPT(Page, Runtime, projectUrl, logger));
    await raceWithDisconnect(openProjectSourcesTab(Runtime, Input, config.inputTimeoutMs, logger));
    await raceWithDisconnect(waitForProjectSourcesReady(Runtime, config.inputTimeoutMs, logger));

    const sourcesBefore = await raceWithDisconnect(
      waitForProjectSourcesListSettled(Runtime, config.inputTimeoutMs, logger),
    );
    let sourcesAfter = sourcesBefore;
    if (operation === "add") {
      sourcesAfter = await raceWithDisconnect(
        uploadProjectSources(
          { runtime: Runtime, dom: DOM, input: Input },
          files,
          logger,
          config.timeoutMs,
        ),
      );
    }
    const added = operation === "add" ? diffAddedProjectSources(sourcesBefore, sourcesAfter) : [];
    completed = true;
    result = {
      status: "ok",
      operation,
      projectUrl,
      dryRun: false,
      sourcesBefore,
      sourcesAfter,
      plannedUploads,
      added,
      warnings,
      tookMs: Date.now() - startedAt,
    };
  } catch (error) {
    primaryError = error;
  }

  removeDialogHandler?.();
  removeTerminationHooks?.();
  const finalization = await resources.settle(completed ? "finalize" : "abort");
  if (finalization.status === "pending") {
    const cleanupError = new BrowserAutomationError(
      `Project Sources browser cleanup remains retryable and is durably journaled for the next Project Sources run: ${finalization.error}`,
      { stage: "project-sources-cleanup", runtime: finalization.runtime },
    );
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "Project Sources operation failed and browser cleanup remains retryable.",
      );
    }
    throw cleanupError;
  }
  if (primaryError !== undefined) throw primaryError;
  if (!result) throw new Error("Project Sources operation completed without a result.");
  return result;
}

async function applyProjectSourcesCookies({
  config,
  network,
  manualLogin,
  logger,
}: {
  config: ResolvedBrowserConfig;
  network: ChromeClient["Network"];
  manualLogin: boolean;
  logger: BrowserLogger;
}): Promise<number> {
  const manualLoginCookieSync = manualLogin && Boolean(config.manualLoginCookieSync);
  const cookieSyncEnabled = config.cookieSync && (!manualLogin || manualLoginCookieSync);
  if (!cookieSyncEnabled) {
    logger(
      manualLogin
        ? "Skipping Chrome cookie sync (--browser-manual-login enabled); reuse the opened profile after signing in."
        : "Skipping Chrome cookie sync (--browser-no-cookie-sync)",
    );
    return 0;
  }
  const cookieCount = await syncCookies(network, config.url, config.chromeProfile, logger, {
    allowErrors: config.allowCookieErrors ?? false,
    filterNames: config.cookieNames ?? undefined,
    inlineCookies: config.inlineCookies ?? undefined,
    cookiePath: config.chromeCookiePath ?? undefined,
    waitMs: config.cookieSyncWaitMs ?? 0,
  });
  logger(
    cookieCount > 0
      ? config.inlineCookies
        ? `Applied ${cookieCount} inline cookies`
        : `Copied ${cookieCount} cookies from Chrome profile ${config.chromeProfile ?? "Default"}`
      : "No Chrome cookies found; continuing without session reuse",
  );
  return cookieCount;
}
