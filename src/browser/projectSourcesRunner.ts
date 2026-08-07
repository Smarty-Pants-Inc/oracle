import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createTemporaryProfileChildAuthority } from "../privateTempRoot.js";
import {
  closeChromeTargetWithExactAuthority,
  connectWithNewTabWithExactAuthority,
  launchChrome,
  positionChromeWindowOffscreen,
  registerTerminationHooks,
  type RetainedChromeEndpointAuthority,
} from "./chromeLifecycle.js";
import { acquireManualChromeOwner } from "./manualChromeOwner.js";
import {
  assertManualLoginProfileReadyForRun,
  defaultManualLoginProfileDir,
} from "./manualLoginProfile.js";
import { resolveBrowserConfig } from "./config.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import { installJavaScriptDialogAutoDismissal, navigateToChatGPT } from "./pageActions.js";
import type { BrowserLogger, ChromeClient, ResolvedBrowserConfig } from "./types.js";
import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  LocalOwnedBrowserResourceAuthority,
  OwnedBrowserResourceTransaction,
} from "./ownedBrowserResources.js";
import { acquireBrowserTabLease, type BrowserTabLease } from "./tabLeaseRegistry.js";
import { createChromeProcessLaunchClaim } from "./chromeProcessLaunchClaim.js";
import { captureProfileDirectoryIdentity, type ProfileDirectoryIdentity } from "./profileState.js";
import { CHATGPT_URL } from "./constants.js";
import {
  openProjectSourcesTab,
  uploadProjectSources,
  waitForProjectSourcesReady,
  waitForProjectSourcesListSettled,
} from "./actions/projectSources.js";
import { normalizeProjectSourcesUrl } from "../projectSources/url.js";
import { buildProjectSourcesUploadPlan, diffAddedProjectSources } from "../projectSources/plan.js";
import type { ProjectSourcesRequest, ProjectSourcesResult } from "../projectSources/types.js";
import {
  assertProjectSourcesCleanupProof,
  assertProjectSourcesCleanupStorage,
  assertProjectSourcesProfileParent,
  assertProjectSourcesTemporaryProof,
  createProjectSourcesManualCleanupProof,
  createProjectSourcesProfileCreateIntent,
  createProjectSourcesTemporaryCleanupProof,
  establishProjectSourcesCleanupStorage,
  persistProjectSourcesCleanupRuntime,
  projectSourcesCleanupOwnerId,
  retireProjectSourcesCleanupJournal,
  retryPendingProjectSourcesCleanup,
  transitionProjectSourcesCleanupProof,
  type ProjectSourcesCleanupProof,
  type ProjectSourcesCleanupStorage,
} from "./projectSourcesRecovery.js";
import { acquireReattachRecoveryLock } from "./reattachLock.js";
import { waitForLogin } from "./localExecutionContext.js";
import { retainChromeTargetCloseCapability } from "./targetCloseAuthority.js";

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

export async function runBrowserProjectSources(
  request: ProjectSourcesRequest,
): Promise<ProjectSourcesResult> {
  if (request.dryRun) return await runBrowserProjectSourcesUnlocked(request);
  const storage = await establishProjectSourcesCleanupStorage();
  await assertProjectSourcesCleanupStorage(storage);
  const recoveryLock = await acquireReattachRecoveryLock(storage.lockPath, storage.runtimeRoot);
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
  const resourceOwnerId = projectSourcesCleanupOwnerId(cleanupStorage);
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
  const leaseId = manualLogin ? randomUUID() : undefined;
  let userDataDir = manualLogin ? manualProfileDir : "";
  let profileDirectoryIdentity: ProfileDirectoryIdentity;
  let cleanupProof: ProjectSourcesCleanupProof;
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
    logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
    await assertManualLoginProfileReadyForRun({
      userDataDir,
      keepBrowser: effectiveKeepBrowser,
    });
    profileDirectoryIdentity = await captureProfileDirectoryIdentity(userDataDir);
    userDataDir = profileDirectoryIdentity.canonicalPath;
    cleanupProof = createProjectSourcesManualCleanupProof(
      cleanupStorage,
      targetGenerationId,
      userDataDir,
      profileDirectoryIdentity,
      leaseId as string,
    );
  } else {
    const parent = await captureProfileDirectoryIdentity(cleanupStorage.runtimeRoot.path);
    const profileCreateIntent = createProjectSourcesProfileCreateIntent(
      cleanupStorage,
      parent,
      targetGenerationId,
    );
    await persistProjectSourcesCleanupRuntime({}, cleanupStorage, {
      profileCreate: profileCreateIntent,
    });
    await assertProjectSourcesProfileParent(profileCreateIntent, cleanupStorage);
    const temporaryProfileAuthority = await createTemporaryProfileChildAuthority(
      cleanupStorage.runtimeRoot,
      "oracle-browser-",
      {
        randomId: () => targetGenerationId,
        windowsPrivateDirectoryAuthority: cleanupStorage.windowsPrivateDirectoryAuthority,
      },
    );
    const establishedIntent = { ...profileCreateIntent, temporaryProfileAuthority };
    await assertProjectSourcesProfileParent(establishedIntent, cleanupStorage);
    await persistProjectSourcesCleanupRuntime({}, cleanupStorage, {
      profileCreate: establishedIntent,
    });
    userDataDir = establishedIntent.userDataDir;
    logger(`Created temporary Chrome profile at ${userDataDir}`);
    cleanupProof = await createProjectSourcesTemporaryCleanupProof(
      establishedIntent,
      cleanupStorage,
    );
    profileDirectoryIdentity = cleanupProof.profileDirectory;
    await persistProjectSourcesCleanupRuntime({}, cleanupStorage, {
      profileCreate: { ...establishedIntent, proof: cleanupProof },
    });
  }
  const assertTemporaryProfileAuthority = async (): Promise<void> => {
    if (cleanupProof.kind === "temporary") {
      await assertProjectSourcesTemporaryProof(cleanupProof, cleanupStorage);
    }
  };

  let cleanupRetryRuntime: BrowserRuntimeMetadata | undefined;
  const persistOwnedResources = async (
    runtimeToPersist: BrowserRuntimeMetadata,
  ): Promise<BrowserRuntimeMetadata> => {
    if (runtimeToPersist.recoveryCleanupResources?.length) {
      cleanupProof = await transitionProjectSourcesCleanupProof(cleanupProof, cleanupStorage, {
        type: "persist",
        runtime: runtimeToPersist,
      });
      await persistProjectSourcesCleanupRuntime(runtimeToPersist, cleanupStorage, {
        proof: cleanupProof,
      });
      cleanupRetryRuntime = runtimeToPersist;
    } else if (cleanupRetryRuntime) {
      await retireProjectSourcesCleanupJournal(
        cleanupRetryRuntime,
        cleanupProof,
        cleanupStorage,
        logger,
      );
    } else {
      await persistProjectSourcesCleanupRuntime({}, cleanupStorage);
      await transitionProjectSourcesCleanupProof(cleanupProof, cleanupStorage, {
        type: "remove-artifacts",
      });
    }
    return runtimeToPersist;
  };
  const resources = new LocalOwnedBrowserResourceAuthority({
    ownerId: resourceOwnerId,
    purpose: "Project Sources",
    targetLabel: "Project Sources",
    userDataDir,
    profileDirectoryIdentity,
    ...(cleanupProof.kind === "temporary"
      ? { temporaryProfileAuthority: cleanupProof.temporaryProfileAuthority }
      : {}),
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
  const resourceTransaction = new OwnedBrowserResourceTransaction(
    resources.transactionAdapters(),
    resources.runtime(),
  );
  resources.configureSettlementAdapters({
    beforeProcessSettlement: assertTemporaryProfileAuthority,
    beforeTemporaryProfileRemoval: assertTemporaryProfileAuthority,
  });
  let removeTerminationHooks: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let completed = false;
  let result: ProjectSourcesResult | undefined;
  let primaryError: unknown;
  try {
    let acquiredTabLease: BrowserTabLease | undefined;
    if (manualLogin) {
      acquiredTabLease = await resources.journalAcquisition(resourceTransaction, {
        resource: "tab-lease",
        acquire: () =>
          acquireBrowserTabLease(userDataDir, {
            maxConcurrentTabs: config.maxConcurrentTabs,
            timeoutMs: config.timeoutMs,
            logger,
            sessionId: resourceOwnerId,
            generationId: targetGenerationId,
            leaseId,
          }),
        authority: (lease) => lease,
      });
    }
    const acquiredProcess = await resources.journalAcquisition(resourceTransaction, {
      resource: "chrome-process",
      acquire: async () => {
        if (manualLogin) {
          const owner = await acquireManualChromeOwner(
            userDataDir,
            config,
            logger,
            resourceOwnerId,
            { launchClaim: processLaunchClaim },
          );
          return { kind: "manual" as const, owner };
        }
        await assertTemporaryProfileAuthority();
        const chrome = await launchChrome({ ...config, remoteChrome: null }, userDataDir, logger, {
          launchClaim: processLaunchClaim,
        });
        return {
          kind: "temporary" as const,
          chrome: {
            ...chrome,
            kill: async () => {
              const termination = await chrome.kill();
              await assertTemporaryProfileAuthority();
              return termination;
            },
          },
        };
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
    const connection = await resources.journalAcquisition(resourceTransaction, {
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
          ownerId: resourceOwnerId,
          generationId: targetGenerationId,
          targetId: opened.targetId as string,
          browserWSEndpoint: acquiredEndpointAuthority.browserWSEndpoint,
          close: async (closeLogger) => {
            const closed = await closeChromeTargetWithExactAuthority({
              authority: acquiredEndpointAuthority,
              targetId: opened.targetId as string,
              logger: closeLogger,
            });
            if (closed.status === "unsafe") throw new Error(closed.reason);
            return closed;
          },
          ...(effectiveKeepBrowser ? { release: () => acquiredEndpointAuthority.release() } : {}),
        }),
        disconnect: () => opened.client.close().catch(() => undefined),
      }),
    });
    const projectClient = connection.client;
    const projectBrowserClient = connection.browserClient;
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

    const { Network, Page, Runtime, Input, DOM } = projectClient;
    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    if (!config.headless && config.hideWindow) {
      await positionChromeWindowOffscreen(projectBrowserClient, logger);
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
    await clearStaleChatGptConversationCookies(Network, projectBrowserClient.Target, logger);

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
  let finalization;
  try {
    const runtimeBeforeSettlement = resourceTransaction.runtime();
    if (runtimeBeforeSettlement.recoveryCleanupResources?.length) {
      cleanupProof = await transitionProjectSourcesCleanupProof(cleanupProof, cleanupStorage, {
        type: "persist",
        runtime: runtimeBeforeSettlement,
      });
      await persistProjectSourcesCleanupRuntime(runtimeBeforeSettlement, cleanupStorage, {
        proof: cleanupProof,
      });
      cleanupRetryRuntime = runtimeBeforeSettlement;
      await assertProjectSourcesCleanupProof(runtimeBeforeSettlement, cleanupProof, cleanupStorage);
    }
    finalization = await resourceTransaction.settle(completed ? "finalize" : "abort");
  } catch (error) {
    const cleanupError = new BrowserAutomationError(
      `Project Sources browser cleanup proof is unavailable; exact resources remain durably journaled: ${error instanceof Error ? error.message : String(error)}`,
      { stage: "project-sources-cleanup", runtime: resourceTransaction.runtime() },
      error,
    );
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "Project Sources operation failed and browser cleanup remains retryable.",
      );
    }
    throw cleanupError;
  }
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
