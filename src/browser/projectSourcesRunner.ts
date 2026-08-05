import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeChromeTargetWithExactAuthority,
  connectWithNewTabWithExactAuthority,
  launchChrome,
  positionChromeWindowOffscreen,
  registerTerminationHooks,
  type RetainedChromeEndpointAuthority,
} from "./chromeLifecycle.js";
import {
  acquireManualChromeOwner,
  releaseManualChromeOwnerEndpointAuthority,
  settleManualChromeOwner,
  type BrowserChrome,
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
import type { BrowserRuntimeMetadata } from "../sessionManager.js";
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
  isSafeChromeTerminationOutcome,
  removeProfileDirectoryIfIdentityMatches,
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

async function connectOwnedProjectSourcesTarget(
  endpointAuthority: RetainedChromeEndpointAuthority,
  logger: BrowserLogger,
  retries: number,
) {
  return await connectWithNewTabWithExactAuthority(endpointAuthority, logger, "about:blank", {
    retries,
    retryDelayMs: 500,
  });
}

export const connectOwnedProjectSourcesTargetForTest = connectOwnedProjectSourcesTarget;

export async function runBrowserProjectSources(
  request: ProjectSourcesRequest,
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
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : defaultManualLoginProfileDir();
  const userDataDir = manualLogin
    ? manualProfileDir
    : await mkdtemp(path.join(os.tmpdir(), "oracle-project-sources-"));
  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
    logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
    await assertManualLoginProfileReadyForRun({
      userDataDir,
      keepBrowser: effectiveKeepBrowser,
    });
  } else {
    logger(`Created temporary Chrome profile at ${userDataDir}`);
  }

  let tabLease: BrowserTabLease | null = null;
  let owner: ManualChromeOwner | null = null;
  let chrome: BrowserChrome | null = null;
  let endpointAuthority: RetainedChromeEndpointAuthority | null = null;
  let manualLeaseTeardownAuthority: BrowserTabLeaseTeardownAuthority | null = null;
  let isolatedTargetId: string | null = null;
  let client: ChromeClient | null = null;
  let removeTerminationHooks: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let completed = false;
  let targetClosed = false;
  let leaseReleased = false;
  let ownerSettled = false;

  const runtime = (): BrowserRuntimeMetadata => {
    const chromeHost = chrome?.host ?? "127.0.0.1";
    const targetCleanupPending = Boolean(isolatedTargetId && !targetClosed);
    const cleanupPending = Boolean(
      targetCleanupPending || (tabLease && !leaseReleased) || (owner && !ownerSettled),
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
            owner?.processIdentity.profileDirectory ?? tabLease?.profileDirectory,
          chromePort: chrome?.port,
          chromeHost,
          chromeBrowserWSEndpoint: endpointAuthority?.browserWSEndpoint,
          chromeProfileRoot: userDataDir,
          userDataDir,
          chromeTargetId: targetCleanupPending ? (isolatedTargetId ?? undefined) : undefined,
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

  const settleProjectSourcesResources = async (
    mode: BrowserCaptureSettlementMode,
    pendingRuntime: BrowserRuntimeMetadata,
  ): Promise<BrowserCaptureFinalizationResult> => {
    const errors: string[] = [];
    const cleanup = pendingRuntime.recoveryCleanupResources?.[0]?.recoveryCleanup;
    const shouldCloseTarget =
      cleanup?.ownsTarget === true &&
      (mode === "abort" || cleanup.closeOwnedTargetOnComplete === true);
    if (
      mode === "finalize" &&
      cleanup?.ownsTarget === true &&
      typeof cleanup.closeOwnedTargetOnComplete !== "boolean"
    ) {
      return pendingBrowserCaptureCleanup(
        pendingRuntime,
        "Project Sources target finalize disposition is missing",
        mode,
      );
    }
    await client?.close().catch(() => undefined);
    if (shouldCloseTarget && isolatedTargetId && chrome && !targetClosed) {
      if (!endpointAuthority) {
        errors.push("Project Sources target has no retained exact endpoint authority");
      } else {
        try {
          const closed = await closeChromeTargetWithExactAuthority({
            authority: endpointAuthority,
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
    { settleResources: settleProjectSourcesResources },
    runtime(),
  );
  let result: ProjectSourcesResult | undefined;
  let primaryError: unknown;
  try {
    if (manualLogin) {
      tabLease = await acquireBrowserTabLease(userDataDir, {
        maxConcurrentTabs: config.maxConcurrentTabs,
        timeoutMs: config.timeoutMs,
        logger,
        sessionId: "project-sources",
      });
    }
    let acquired: ManualChromeOwner;
    if (manualLogin) {
      acquired = await acquireManualChromeOwner(userDataDir, config, logger, "project-sources");
    } else {
      const launchedChrome = await launchChrome(
        { ...config, remoteChrome: null },
        userDataDir,
        logger,
      );
      acquired = {
        chrome: launchedChrome,
        processIdentity: launchedChrome.processIdentity,
        source: "launched",
        disposition: "close-on-last-lease",
      };
    }
    owner = acquired;
    chrome = acquired.chrome;
    endpointAuthority = acquired.endpointAuthority ?? chrome.endpointAuthority ?? null;
    if (!endpointAuthority) {
      throw new Error("Project Sources Chrome has no retained exact endpoint authority.");
    }
    const chromeHost = chrome.host ?? "127.0.0.1";
    if (manualLogin && tabLease && acquired.disposition === "close-on-last-lease") {
      const ownerForHandoff = acquired;
      manualLeaseTeardownAuthority = retainBrowserTabLeaseTeardownAuthority(userDataDir, tabLease, {
        logger,
        onActiveLeaseHandoff: () => releaseManualChromeOwnerEndpointAuthority(ownerForHandoff),
      });
    }
    if (tabLease) {
      await tabLease.update({ chromeHost, chromePort: chrome.port });
    }

    removeTerminationHooks = registerTerminationHooks(
      chrome,
      userDataDir,
      effectiveKeepBrowser || (manualLogin && acquired.disposition === "preserve"),
      logger,
      {
        isInFlight: () => !completed,
        preserveUserDataDir: manualLogin,
      },
    );

    const devtoolsRetries = manualLogin ? 6 : 0;
    const connection = await connectOwnedProjectSourcesTarget(
      endpointAuthority,
      logger,
      devtoolsRetries,
    );
    client = connection.client;
    isolatedTargetId = connection.targetId ?? null;
    if (tabLease && isolatedTargetId) {
      await tabLease.update({
        chromeHost,
        chromePort: chrome.port,
        chromeTargetId: isolatedTargetId,
        tabUrl: projectUrl,
      });
    }

    const disconnectPromise = new Promise<never>((_, reject) => {
      client?.on("disconnect", () => {
        reject(new Error("Chrome window closed before Project Sources finished."));
      });
    });
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, disconnectPromise]);

    const { Network, Page, Runtime, Input, DOM, Target } = client;
    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    if (!config.headless && config.hideWindow) {
      await positionChromeWindowOffscreen(client, logger);
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
    const cleanupError = new BrowserAutomationError(
      `Project Sources browser cleanup remains retryable: ${finalization.error}`,
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
