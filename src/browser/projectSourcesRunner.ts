import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeTab,
  connectWithNewTab,
  launchChrome,
  positionChromeWindowOffscreen,
  registerTerminationHooks,
} from "./chromeLifecycle.js";
import {
  acquireManualChromeOwner,
  settleManualChromeOwner,
  type BrowserChrome,
  type ManualChromeOwner,
  type ManualChromeOwnerSource,
} from "./manualChromeOwner.js";
import { resolveBrowserConfig } from "./config.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import {
  installJavaScriptDialogAutoDismissal,
  navigateToChatGPT,
  ensureLoggedIn,
} from "./pageActions.js";
import type { BrowserLogger, ChromeClient, ResolvedBrowserConfig } from "./types.js";
import {
  acquireBrowserTabLease,
  retainBrowserTabLeaseTeardownAuthority,
  type BrowserTabLease,
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
  if (manualLogin) {
    tabLease = await acquireBrowserTabLease(userDataDir, {
      maxConcurrentTabs: config.maxConcurrentTabs,
      timeoutMs: config.timeoutMs,
      logger,
      sessionId: "project-sources",
    });
  }

  let owner: ManualChromeOwner | null = null;
  let chrome: BrowserChrome | null = null;
  let chromeOwnerSource: ManualChromeOwnerSource | null = null;
  let manualLeaseTeardownAuthority: ReturnType<
    typeof retainBrowserTabLeaseTeardownAuthority
  > | null = null;
  let isolatedTargetId: string | null = null;
  let client: ChromeClient | null = null;
  let removeTerminationHooks: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let completed = false;

  try {
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
    chromeOwnerSource = acquired.source;
    const chromeHost = chrome.host ?? "127.0.0.1";
    if (manualLogin && tabLease && acquired.disposition === "close-on-last-lease") {
      manualLeaseTeardownAuthority = retainBrowserTabLeaseTeardownAuthority(userDataDir, tabLease, {
        logger,
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

    const strictTabIsolation = Boolean(manualLogin && chromeOwnerSource !== "launched");
    const devtoolsRetries = manualLogin ? 6 : 0;
    const connection = await connectWithNewTab(chrome.port, logger, "about:blank", chromeHost, {
      fallbackToDefault: !strictTabIsolation,
      retries: devtoolsRetries,
      retryDelayMs: 500,
    });
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
    return {
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
  } finally {
    removeDialogHandler?.();
    removeTerminationHooks?.();
    const chromeHost = chrome?.host ?? "127.0.0.1";
    const chromeForTabClose = chrome;
    try {
      await client?.close();
    } catch {
      // ignore close failures
    }
    if (!effectiveKeepBrowser && isolatedTargetId && chromeForTabClose) {
      await closeTab(chromeForTabClose.port, isolatedTargetId, logger, chromeHost).catch(
        () => undefined,
      );
    }

    let keepBrowserOpen =
      effectiveKeepBrowser || (manualLogin && owner?.disposition === "preserve");
    let manualProcessSettled = false;
    const chromeForCleanup = chrome;
    if (manualLeaseTeardownAuthority && chromeForCleanup && owner) {
      const ownerForSettlement = owner;
      const outcome = await manualLeaseTeardownAuthority.settle(async () => {
        const settlement = await settleManualChromeOwner(userDataDir, ownerForSettlement, logger);
        return settlement.status === "terminated";
      });
      if (manualLeaseTeardownAuthority.leaseReleased) tabLease = null;
      if (outcome.status === "completed" && outcome.disposition === "teardown-completed") {
        manualProcessSettled = true;
      }
      if (outcome.status === "completed" && outcome.disposition === "active-lease-handoff") {
        keepBrowserOpen = true;
        logger("[browser] Other ChatGPT tab leases still active; leaving shared Chrome running.");
      } else if (outcome.status === "preserved") {
        keepBrowserOpen = true;
        logger(`[browser] Preserving shared Chrome resources: ${outcome.error ?? outcome.reason}`);
      }
    } else if (tabLease) {
      const handle = tabLease;
      tabLease = null;
      const released = await handle
        .release()
        .then(() => true)
        .catch((error: unknown) => {
          logger(
            `[browser] Browser lease release was unavailable; preserving shared Chrome: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        });
      if (!released) {
        keepBrowserOpen = true;
      } else if (manualLogin && owner?.disposition === "preserve") {
        const settlement = await settleManualChromeOwner(userDataDir, owner, logger);
        if (settlement.status === "unsafe") {
          keepBrowserOpen = true;
          logger(`[browser] Preserving shared Chrome resources: ${settlement.reason}`);
        }
      }
    }
    if (!keepBrowserOpen && !manualLogin && chromeForCleanup) {
      const termination = await chromeForCleanup.kill().catch(
        (error: unknown): RecordedChromeTerminationOutcome => ({
          status: "unsafe",
          pid: chromeForCleanup.pid,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      if (!isSafeChromeTerminationOutcome(termination)) {
        logger(`[browser] Preserving profile and cleanup authority: ${termination.reason}`);
      } else if (!manualLogin) {
        const removed = await removeProfileDirectoryIfIdentityMatches(
          userDataDir,
          chromeForCleanup.processIdentity.profileDirectory,
        ).catch(() => false);
        if (!removed)
          logger("[browser] Physical profile removal was not confirmed; preserving state.");
      }
    } else if (chromeForCleanup && !manualProcessSettled) {
      try {
        chromeForCleanup.process?.unref?.();
      } catch {
        // best effort
      }
      logger(`Chrome left running on port ${chromeForCleanup.port} with profile ${userDataDir}`);
    }
  }
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
