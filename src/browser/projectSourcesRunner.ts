import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  closeChromeTargetWithExactAuthority,
  connectWithNewTabWithExactAuthority,
  launchChrome,
  positionChromeWindowOffscreen,
  registerTerminationHooks,
  retainChromeEndpointAuthority,
  type RetainedChromeEndpointAuthority,
  type ChromeLaunchResult,
} from "./chromeLifecycle.js";
import {
  acquireManualChromeOwner,
  releaseManualChromeOwnerEndpointAuthority,
  settleManualChromeOwner,
  type ManualChromeOwner,
} from "./manualChromeOwner.js";
import { resolveBrowserConfig } from "./config.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import {
  installJavaScriptDialogAutoDismissal,
  navigateToChatGPT,
  ensureLoggedIn,
} from "./pageActions.js";
import type {
  BrowserCaptureFinalizationResult,
  BrowserLogger,
  ChromeClient,
  ResolvedBrowserConfig,
} from "./types.js";
import type {
  BrowserRecoveryTargetCloseCapabilityMetadata,
  BrowserRuntimeMetadata,
} from "../sessionManager.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  OwnedBrowserResourceTransaction,
  completedBrowserCaptureCleanup,
  pendingBrowserCaptureCleanup,
  type BrowserCaptureSettlementMode,
} from "./ownedBrowserResources.js";
import {
  acquireBrowserTabLease,
  retainBrowserTabLeaseTeardownAuthority,
  type BrowserTabLease,
  type BrowserTabLeaseTeardownAuthority,
} from "./tabLeaseRegistry.js";
import {
  captureProfileDirectoryIdentity,
  createChromeProcessLaunchClaim,
  isSafeChromeTerminationOutcome,
  parseChromeProcessLaunchClaim,
  parseProfileDirectoryIdentity,
  removeProfileDirectoryIfIdentityMatches,
  sameChromeProcessLaunchClaim,
  sameProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
  type RecordedChromeTerminationOutcome,
} from "./profileState.js";
import { CHATGPT_URL } from "./constants.js";
import { delay } from "./utils.js";
import {
  assertManualLoginProfileReadyForRun,
  defaultManualLoginProfileDir,
  formatManualLoginSetupCommand,
  resolveManualLoginWaitMs,
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
import { syncDirectoryIfSupported, writeFileAtomicDurable } from "../sessionManager.js";
import { retryBrowserRecoveryCleanup } from "./reattach.js";
import { acquireReattachRecoveryLock } from "./reattachLock.js";
import { resolveUserDataBaseDir } from "./localExecutionContext.js";
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
  await syncDirectoryIfSupported(path.dirname(resolvedStorage.journalPath)).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    },
  );
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
): Promise<boolean> {
  const intent = journal.profileCreate;
  if (!intent) return false;
  const parent = await captureProfileDirectoryIdentity(intent.parent.canonicalPath);
  if (!sameProfileDirectoryIdentity(parent, intent.parent)) {
    throw new Error("Project Sources temporary profile parent authority changed before recovery.");
  }
  try {
    await captureProfileDirectoryIdentity(intent.userDataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await persistProjectSourcesCleanupRuntime({}, storage);
      return true;
    }
    throw error;
  }
  throw new Error(
    "Project Sources temporary profile exists without a durably recorded physical identity; preserving it for manual recovery.",
  );
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
  if (!journal || (await recoverPendingProjectSourcesProfileCreate(journal, resolvedStorage)))
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
    await mkdir(temporaryProfileDir);
    userDataDir = temporaryProfileDir;
    logger(`Created temporary Chrome profile at ${userDataDir}`);
    profileDirectoryIdentity = await captureProfileDirectoryIdentity(userDataDir);
  }

  let acquisitionPendingResource: "tab-lease" | "chrome-process" | "chrome-target" | undefined =
    manualLogin ? "tab-lease" : "chrome-process";
  let tabLease: BrowserTabLease | null = null;
  let owner: ManualChromeOwner | null = null;
  let chrome: ChromeLaunchResult | null = null;
  let endpointAuthority: RetainedChromeEndpointAuthority | null = null;
  let manualLeaseTeardownAuthority: BrowserTabLeaseTeardownAuthority | null = null;
  let isolatedTargetId: string | null = null;
  let targetCloseCapability: BrowserRecoveryTargetCloseCapabilityMetadata | undefined;
  let client: ChromeClient | null = null;
  let removeTerminationHooks: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let completed = false;
  let targetClosed = false;
  let leaseReleased = false;
  let ownerSettled = false;

  const runtime = (): BrowserRuntimeMetadata => {
    const chromeHost = chrome?.host ?? "127.0.0.1";
    const targetCleanupPending = Boolean(
      acquisitionPendingResource === "chrome-target" || (isolatedTargetId && !targetClosed),
    );
    const cleanupPending = Boolean(
      acquisitionPendingResource ||
      targetCleanupPending ||
      (tabLease && !leaseReleased) ||
      (owner && !ownerSettled),
    );
    const base: BrowserRuntimeMetadata = {
      browserTransport: "cdp",
      chromePid: chrome?.pid,
      chromeProcessIdentity: owner?.processIdentity,
      chromePort: chrome?.port,
      chromeHost,
      chromeBrowserWSEndpoint: endpointAuthority?.browserWSEndpoint,
      chromeProfileRoot: userDataDir,
      userDataDir,
      chromeTargetId: targetCleanupPending ? (isolatedTargetId ?? undefined) : undefined,
      tabUrl: projectUrl,
      controllerPid: process.pid,
    };
    if (!cleanupPending) return base;
    return {
      ...base,
      recoveryCleanupResources: [
        {
          chromePid: chrome?.pid,
          chromeProcessIdentity: owner?.processIdentity,
          profileDirectoryIdentity:
            owner?.processIdentity.profileDirectory ??
            tabLease?.profileDirectory ??
            profileDirectoryIdentity,
          chromePort: chrome?.port,
          chromeHost,
          chromeBrowserWSEndpoint: endpointAuthority?.browserWSEndpoint,
          chromeProfileRoot: userDataDir,
          userDataDir,
          chromeTargetId: targetCleanupPending ? (isolatedTargetId ?? undefined) : undefined,
          targetCloseCapability: targetCleanupPending ? targetCloseCapability : undefined,
          acquisition: {
            generationId: targetGenerationId,
            processOwnerProvenance: manualLogin ? "manual-canonical-owner" : "temporary-launch",
            processLaunchClaim,
            processOwnerDisposition: effectiveKeepBrowser ? "preserve" : "close-on-last-lease",
            targetMarkerUrl,
            ...(acquisitionPendingResource ? { pendingResource: acquisitionPendingResource } : {}),
          },
          tabLease:
            tabLease && !leaseReleased
              ? { id: tabLease.id, profileDirectory: tabLease.profileDirectory }
              : undefined,
          recoveryCleanup: {
            ownsTarget: targetCleanupPending,
            profileKind: manualLogin ? "manual-login" : "temporary",
            keepBrowser: effectiveKeepBrowser || (manualLogin && owner?.disposition === "preserve"),
            closeOwnedTargetOnComplete: !effectiveKeepBrowser,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
  };
  await persistProjectSourcesCleanupRuntime(runtime(), cleanupStorage);

  const settleProjectSourcesResources = async (
    mode: BrowserCaptureSettlementMode,
    pendingRuntime: BrowserRuntimeMetadata,
  ): Promise<BrowserCaptureFinalizationResult> => {
    const errors: string[] = [];
    const cleanup = pendingRuntime.recoveryCleanupResources?.[0]?.recoveryCleanup;
    const shouldCloseTarget =
      cleanup?.ownsTarget === true && cleanup.closeOwnedTargetOnComplete === true;
    if (cleanup?.ownsTarget === true && typeof cleanup.closeOwnedTargetOnComplete !== "boolean") {
      return pendingBrowserCaptureCleanup(
        pendingRuntime,
        "Project Sources target close disposition is missing",
        mode,
      );
    }
    await client?.close().catch(() => undefined);
    if (shouldCloseTarget && isolatedTargetId && chrome && !targetClosed) {
      if (!targetCloseCapability) {
        errors.push("Project Sources target has no retained exact close capability");
      } else {
        try {
          const closed = await closeChromeTargetWithRetainedCapability({
            capability: targetCloseCapability,
            targetId: isolatedTargetId,
            logger,
          });
          if (closed.status === "completed" || closed.status === "gone") targetClosed = true;
          else errors.push(closed.reason);
        } catch (error) {
          errors.push(
            `Project Sources target close failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    if (errors.length > 0) {
      return pendingBrowserCaptureCleanup(runtime(), errors.join("; "), mode);
    }

    let keepBrowserOpen =
      effectiveKeepBrowser || (manualLogin && owner?.disposition === "preserve");
    if (manualLeaseTeardownAuthority && owner) {
      let teardownError: string | null = null;
      const ownerForSettlement = owner;
      const outcome = await manualLeaseTeardownAuthority.settle(async () => {
        const settlement = await settleManualChromeOwner(userDataDir, ownerForSettlement, logger);
        if (settlement.status === "unsafe") {
          teardownError = settlement.reason;
          return false;
        }
        ownerSettled = true;
        return true;
      });
      leaseReleased = manualLeaseTeardownAuthority.leaseReleased;
      if (outcome.status === "completed" && outcome.disposition === "active-lease-handoff") {
        keepBrowserOpen = true;
        ownerSettled = true;
        logger("[browser] Other ChatGPT tab leases still active; leaving shared Chrome running.");
      } else if (outcome.status === "preserved") {
        keepBrowserOpen = true;
        errors.push(teardownError ?? outcome.error ?? outcome.reason);
      }
    } else if (tabLease && !leaseReleased) {
      try {
        await tabLease.release();
        leaseReleased = true;
      } catch (error) {
        keepBrowserOpen = true;
        errors.push(
          `Project Sources browser lease release failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (leaseReleased && manualLogin && owner && !ownerSettled) {
        const settlement = await settleManualChromeOwner(userDataDir, owner, logger);
        if (settlement.status === "unsafe") {
          keepBrowserOpen = true;
          errors.push(settlement.reason);
        } else {
          ownerSettled = true;
          keepBrowserOpen = true;
        }
      }
    }
    if (
      errors.length === 0 &&
      manualLogin &&
      !manualLeaseTeardownAuthority &&
      leaseReleased &&
      owner &&
      !ownerSettled
    ) {
      const settlement = await settleManualChromeOwner(userDataDir, owner, logger);
      if (settlement.status === "unsafe") {
        keepBrowserOpen = true;
        errors.push(settlement.reason);
      } else {
        ownerSettled = true;
        keepBrowserOpen = true;
      }
    }
    if (!keepBrowserOpen && !manualLogin && chrome && !ownerSettled) {
      const termination = await chrome.kill().catch(
        (error: unknown): RecordedChromeTerminationOutcome => ({
          status: "unsafe",
          pid: chrome?.pid ?? -1,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      if (!isSafeChromeTerminationOutcome(termination)) {
        keepBrowserOpen = true;
        errors.push(termination.reason);
      } else {
        const removed = await removeProfileDirectoryIfIdentityMatches(
          userDataDir,
          chrome.processIdentity.profileDirectory,
        ).catch(() => false);
        if (!removed) errors.push(`Profile removal was not confirmed: ${userDataDir}`);
        else ownerSettled = true;
      }
    }
    if (keepBrowserOpen && chrome) {
      try {
        chrome.process?.unref?.();
      } catch {
        // Best effort only; retained Chrome ownership is recorded independently.
      }
      logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
    }
    const projectedRuntime = runtime();
    return errors.length > 0
      ? pendingBrowserCaptureCleanup(projectedRuntime, [...new Set(errors)].join("; "), mode)
      : completedBrowserCaptureCleanup(projectedRuntime);
  };

  const resources = new OwnedBrowserResourceTransaction(
    {
      persistRuntime: async (runtimeToPersist) => {
        await persistProjectSourcesCleanupRuntime(runtimeToPersist, cleanupStorage);
        return runtimeToPersist;
      },
      persistSettlementResult: async (settledRuntime) => {
        await persistProjectSourcesCleanupRuntime(settledRuntime, cleanupStorage);
      },
      settleResources: settleProjectSourcesResources,
    },
    runtime(),
  );
  let result: ProjectSourcesResult | undefined;
  let primaryError: unknown;
  try {
    let acquiredTabLease: BrowserTabLease | undefined;
    if (manualLogin) {
      acquiredTabLease = await resources.journalAcquisition({
        intentRuntime: runtime(),
        acquire: () =>
          acquireBrowserTabLease(userDataDir, {
            maxConcurrentTabs: config.maxConcurrentTabs,
            timeoutMs: config.timeoutMs,
            logger,
            sessionId: "project-sources",
          }),
        acquiredRuntime: (lease) => {
          tabLease = lease;
          acquisitionPendingResource = undefined;
          return runtime();
        },
      });
    }
    acquisitionPendingResource = "chrome-process";
    const acquired = await resources.journalAcquisition<ManualChromeOwner>({
      intentRuntime: runtime(),
      acquire: async () => {
        if (manualLogin) {
          return await acquireManualChromeOwner(userDataDir, config, logger, "project-sources", {
            launchClaim: processLaunchClaim,
          });
        }
        const launchedChrome = await launchChrome(
          { ...config, remoteChrome: null },
          userDataDir,
          logger,
          { launchClaim: processLaunchClaim },
        );
        return {
          chrome: launchedChrome,
          processIdentity: launchedChrome.processIdentity,
          source: "launched" as const,
          disposition: "close-on-last-lease" as const,
        };
      },
      acquiredRuntime: (acquiredOwner) => {
        owner = acquiredOwner;
        chrome = acquiredOwner.chrome;
        endpointAuthority =
          acquiredOwner.endpointAuthority ?? acquiredOwner.chrome.endpointAuthority ?? null;
        acquisitionPendingResource = undefined;
        return runtime();
      },
    });
    const acquiredChrome = acquired.chrome;
    const acquiredEndpointAuthority =
      acquired.endpointAuthority ?? acquiredChrome.endpointAuthority;
    if (!acquiredEndpointAuthority) {
      throw new Error("Project Sources Chrome has no retained exact endpoint authority.");
    }
    owner = acquired;
    chrome = acquiredChrome;
    endpointAuthority = acquiredEndpointAuthority;
    const chromeHost = acquiredChrome.host ?? "127.0.0.1";
    if (manualLogin && acquiredTabLease && acquired.disposition === "close-on-last-lease") {
      const ownerForHandoff = acquired;
      manualLeaseTeardownAuthority = retainBrowserTabLeaseTeardownAuthority(
        userDataDir,
        acquiredTabLease,
        {
          logger,
          onActiveLeaseHandoff: () => releaseManualChromeOwnerEndpointAuthority(ownerForHandoff),
        },
      );
    }
    if (acquiredTabLease) {
      await acquiredTabLease.update({ chromeHost, chromePort: acquiredChrome.port });
    }

    removeTerminationHooks = registerTerminationHooks(
      acquiredChrome,
      userDataDir,
      effectiveKeepBrowser || (manualLogin && acquired.disposition === "preserve"),
      logger,
      {
        isInFlight: () => !completed,
        preserveUserDataDir: manualLogin,
      },
    );

    acquisitionPendingResource = "chrome-target";
    const devtoolsRetries = manualLogin ? 6 : 0;
    const connection = await resources.journalAcquisition<{
      client: ChromeClient;
      targetId: string;
    }>({
      intentRuntime: runtime(),
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
        return { client: opened.client, targetId: opened.targetId };
      },
      acquiredRuntime: (connected) => {
        client = connected.client;
        isolatedTargetId = connected.targetId;
        targetCloseCapability = retainChromeTargetCloseCapability({
          generationId: targetGenerationId,
          targetId: connected.targetId,
          close: (closeLogger) =>
            closeChromeTargetWithExactAuthority({
              authority: acquiredEndpointAuthority,
              targetId: connected.targetId,
              logger: closeLogger,
            }),
          ...(effectiveKeepBrowser ? { release: () => acquiredEndpointAuthority.release() } : {}),
        });
        acquisitionPendingResource = undefined;
        return runtime();
      },
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
      waitForProjectSourcesLogin({
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
  resources.replaceRuntime(runtime());
  const finalization = await resources.settle(completed ? "finalize" : "abort");
  if (finalization.status === "pending") {
    try {
      await persistProjectSourcesCleanupRuntime(finalization.runtime, cleanupStorage);
    } catch (persistenceError) {
      const cleanupError = new BrowserAutomationError(
        `Project Sources browser cleanup could not be durably recorded: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`,
        { stage: "project-sources-cleanup", runtime: finalization.runtime },
      );
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          "Project Sources operation failed and browser cleanup authority could not be durably recorded.",
        );
      }
      throw cleanupError;
    }
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

async function waitForProjectSourcesLogin({
  runtime,
  logger,
  appliedCookies,
  manualLogin,
  timeoutMs,
  profileDir,
  keepBrowser,
}: {
  runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  appliedCookies: number;
  manualLogin: boolean;
  timeoutMs: number;
  profileDir?: string;
  keepBrowser?: boolean;
}): Promise<void> {
  if (!manualLogin) {
    await ensureLoggedIn(runtime, logger, { appliedCookies });
    return;
  }
  const waitMs = resolveManualLoginWaitMs(timeoutMs, Boolean(keepBrowser));
  const deadline = Date.now() + waitMs;
  let lastNotice = 0;
  while (Date.now() < deadline) {
    try {
      await ensureLoggedIn(runtime, logger, { appliedCookies });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        message.toLowerCase().includes("login button") ||
        message.toLowerCase().includes("session not detected");
      if (!retryable) {
        throw error;
      }
      const now = Date.now();
      if (now - lastNotice > 5000) {
        logger(
          "Manual login mode: please sign into chatgpt.com in the opened Chrome window; waiting for session to appear...",
        );
        lastNotice = now;
      }
      await delay(1000);
    }
  }
  const setupCommand = formatManualLoginSetupCommand(profileDir ?? defaultManualLoginProfileDir());
  throw new Error(
    "Manual login mode timed out waiting for ChatGPT session. " +
      `Browser mode is using Oracle's private Chrome profile at ${profileDir ?? "(default profile)"}, not your normal Chrome profile. ` +
      `Run first-time setup, sign in there, then retry: ${setupCommand}`,
  );
}
