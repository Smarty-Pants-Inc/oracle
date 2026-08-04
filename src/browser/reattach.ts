import CDP from "chrome-remote-interface";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import {
  waitForAssistantResponse,
  captureAssistantMarkdown,
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  waitForResumedConversationHydration,
} from "./pageActions.js";
import type { BrowserLogger, ChromeClient } from "./types.js";
import {
  launchChrome,
  connectToChrome,
  positionChromeWindowOffscreen,
  connectToRemoteChromeTarget,
  listRemoteChromeTargets,
  closeChromeTarget,
} from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import { CHATGPT_URL } from "./constants.js";
import { buildConversationTurnListExpression } from "./conversationTurns.js";
import {
  cleanupStaleProfileState,
  isProcessAlive,
  isSafeChromeTerminationOutcome,
  terminateRecordedChromeForProfile,
  writeChromePid,
} from "./profileState.js";
import {
  acquireBrowserTabLease,
  teardownBrowserResourcesIfNoActiveLeases,
} from "./tabLeaseRegistry.js";
import { readDevToolsActivePortInfo } from "./detect.js";
import {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  withTimeout,
  openConversationFromSidebar,
  openConversationFromSidebarWithRetry,
  waitForLocationChange,
  readConversationTurnIndex,
  buildPromptEchoMatcher,
  recoverPromptEcho,
  alignPromptEchoMarkdown,
  type TargetInfoLite,
} from "./reattachHelpers.js";
import { waitForDeepResearchCompletion } from "./actions/deepResearch.js";

export interface ReattachCleanupDeps {
  closeChromeTarget?: typeof closeChromeTarget;
  terminateRecordedChromeForProfile?: typeof terminateRecordedChromeForProfile;
  cleanupStaleProfileState?: typeof cleanupStaleProfileState;
  teardownBrowserResourcesIfNoActiveLeases?: typeof teardownBrowserResourcesIfNoActiveLeases;
  removeProfile?: (profileDir: string) => Promise<boolean | void>;
}

export interface ReattachRecoveryLock {
  path: string;
  release: () => Promise<void>;
}

export interface ReattachCapture {
  answerText: string;
  answerMarkdown: string;
  runtime?: BrowserRuntimeMetadata;
  finalizeResources?: () => Promise<ReattachFinalizationResult>;
  abandonResources?: () => Promise<void>;
}

export interface ReattachDeps {
  listTargets?: () => Promise<TargetInfoLite[]>;
  connect?: (options?: unknown) => Promise<ChromeClient>;
  waitForAssistantResponse?: typeof waitForAssistantResponse;
  captureAssistantMarkdown?: typeof captureAssistantMarkdown;
  waitForDeepResearchCompletion?: typeof waitForDeepResearchCompletion;
  waitForConversationHydration?: typeof waitForResumedConversationHydration;
  recoverSession?: (
    runtime: BrowserRuntimeMetadata,
    config: BrowserSessionConfig | undefined,
  ) => Promise<ReattachCapture>;
  promptPreview?: string;
  recoveryCleanup?: ReattachCleanupDeps;
  recoveryLockPath?: string;
  acquireRecoveryLock?: (lockPath: string) => Promise<ReattachRecoveryLock>;
}

export type ReattachFinalizationResult =
  | { status: "completed"; runtime: BrowserRuntimeMetadata }
  | { status: "pending"; runtime: BrowserRuntimeMetadata; error: string };

export interface ReattachResult {
  answerText: string;
  answerMarkdown: string;
  runtime: BrowserRuntimeMetadata;
  finalize: () => Promise<ReattachFinalizationResult>;
  abandon: () => Promise<void>;
}

export async function resumeBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  const lockPath = deps.recoveryLockPath ?? defaultRecoveryLockPath(runtime);
  const recoveryLock = await (deps.acquireRecoveryLock ?? acquireReattachRecoveryLock)(lockPath);
  let lockHeld = true;
  const releaseRecoveryLock = async (): Promise<void> => {
    if (!lockHeld) return;
    await recoveryLock.release();
    lockHeld = false;
  };
  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) =>
      resumeBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, deps));
  let closeAttachedConnection: (() => Promise<void>) | null = null;
  const closeAttached = async (): Promise<void> => {
    const close = closeAttachedConnection;
    closeAttachedConnection = null;
    await close?.().catch(() => undefined);
  };

  const buildResult = (capture: ReattachCapture): ReattachResult => {
    const capturedRuntime = markRecoveryCleanupPending(capture.runtime ?? runtime);
    let finalization: Promise<ReattachFinalizationResult> | null = null;
    let abandoned = false;
    return {
      answerText: capture.answerText,
      answerMarkdown: capture.answerMarkdown,
      runtime: capturedRuntime,
      finalize: async () => {
        if (abandoned) {
          return pendingFinalization(capturedRuntime, "Recovery was abandoned before cleanup");
        }
        finalization ??= (async () => {
          let result: ReattachFinalizationResult;
          try {
            result = capture.finalizeResources
              ? await capture.finalizeResources()
              : await finalizeRecoveredRuntime(
                  capture.runtime ?? runtime,
                  logger,
                  deps.recoveryCleanup,
                );
          } catch (error) {
            result = pendingFinalization(
              capture.runtime ?? runtime,
              error instanceof Error ? error.message : String(error),
            );
          }
          try {
            await releaseRecoveryLock();
          } catch (error) {
            return pendingFinalization(
              capture.runtime ?? runtime,
              `Cleanup finished but recovery lock release failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return result;
        })();
        return finalization;
      },
      abandon: async () => {
        if (finalization || abandoned) return;
        abandoned = true;
        try {
          await capture.abandonResources?.();
        } finally {
          await releaseRecoveryLock();
        }
      },
    };
  };

  const recover = async (): Promise<ReattachResult> => {
    const capture = await recoverSession(runtime, config);
    return buildResult(capture);
  };

  try {
    if (!runtime.chromePort && !runtime.chromeBrowserWSEndpoint) {
      logger("No running Chrome detected; reopening browser to locate the session.");
      return await recover();
    }

    try {
      const liveRuntime = (await refreshAttachRuntime(runtime).catch(() => runtime)) ?? runtime;
      const host = liveRuntime.chromeHost ?? "127.0.0.1";
      const port =
        liveRuntime.chromePort ??
        inferPortFromBrowserWSEndpoint(liveRuntime.chromeBrowserWSEndpoint);
      const browserWSEndpoint = liveRuntime.chromeBrowserWSEndpoint ?? undefined;
      const listTargets =
        deps.listTargets ??
        (async () =>
          (await listRemoteChromeTargets({
            host,
            port: port ?? 9222,
            browserWSEndpoint,
          })) as TargetInfoLite[]);
      const targetList = (await listTargets()) as TargetInfoLite[];
      const target = pickTarget(targetList, liveRuntime);
      const connection =
        browserWSEndpoint && !deps.connect
          ? await connectToRemoteChromeTarget(host, port ?? 9222, logger, {
              browserWSEndpoint,
              targetId: target?.targetId ?? target?.id,
              closeTargetOnDispose: false,
            })
          : await (async () => {
              const client = (await (
                deps.connect ?? ((options?: unknown) => CDP(options as CDP.Options))
              )(
                browserWSEndpoint
                  ? {
                      target: browserWSEndpoint,
                      local: true,
                      targetId: target?.targetId ?? target?.id,
                    }
                  : {
                      host,
                      port,
                      target: target?.targetId ?? target?.id,
                    },
              )) as unknown as ChromeClient;
              return { client, close: () => client.close() };
            })();
      closeAttachedConnection = () => connection.close();

      const client: ChromeClient = connection.client;
      const { Runtime, DOM, Page } = client;
      if (Runtime?.enable) await Runtime.enable();
      if (DOM && typeof DOM.enable === "function") await DOM.enable();
      if (Page && typeof Page.enable === "function") await Page.enable();

      const ensureConversationOpen = async () => {
        const { result } = await Runtime.evaluate({
          expression: "location.href",
          returnByValue: true,
        });
        const href = typeof result?.value === "string" ? result.value : "";
        if (href.includes("/c/")) {
          const currentId = extractConversationIdFromUrl(href);
          if (!runtime.conversationId || (currentId && currentId === runtime.conversationId))
            return;
        }
        const opened = await openConversationFromSidebarWithRetry(
          Runtime,
          {
            conversationId:
              runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ""),
            preferProjects: true,
            promptPreview: deps.promptPreview,
          },
          15_000,
        );
        if (!opened) throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
        await waitForLocationChange(Runtime, 15_000);
      };

      const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
      const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
      const timeoutMs = config?.timeoutMs ?? 120_000;
      const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
      await withTimeout(
        Runtime.evaluate({ expression: "1+1", returnByValue: true }),
        pingTimeoutMs,
        "Reattach target did not respond",
      );
      await ensureConversationOpen();
      const waitForHydration =
        deps.waitForConversationHydration ?? waitForResumedConversationHydration;
      const expectedConversationUrl = buildConversationUrl(
        runtime,
        resolveBrowserConfig(config ?? {}).url,
      );
      await waitForHydration(Runtime, timeoutMs, logger, {
        requirePriorTurns: true,
        requirePromptReady: false,
        expectedConversationUrl: expectedConversationUrl ?? undefined,
      });
      const minTurnIndex =
        (await readPromptPreviewTurnIndex(Runtime, deps.promptPreview)) ??
        (deps.promptPreview ? null : await readConversationTurnIndex(Runtime, logger));
      if (config?.researchMode === "deep") {
        const waitForDeepResearch =
          deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
        const researchResult = await withTimeout(
          waitForDeepResearch(Runtime, logger, timeoutMs, minTurnIndex ?? undefined, Page, client, {
            requireScopedTargetOwner: true,
          }),
          timeoutMs + 5_000,
          "Reattach Deep Research response timed out",
        );
        await closeAttached();
        return buildResult({
          answerText: researchResult.text,
          answerMarkdown: researchResult.text,
          runtime: liveRuntime,
        });
      }
      const promptEcho = buildPromptEchoMatcher(deps.promptPreview);
      const answer = await withTimeout(
        waitForResponse(Runtime, timeoutMs, logger, minTurnIndex ?? undefined),
        timeoutMs + 5_000,
        "Reattach response timed out",
      );
      const recovered = await recoverPromptEcho(
        Runtime,
        answer,
        promptEcho,
        logger,
        minTurnIndex,
        timeoutMs,
      );
      const markdown =
        (await withTimeout(
          captureMarkdown(Runtime, recovered.meta, logger),
          15_000,
          "Reattach markdown capture timed out",
        )) ?? recovered.text;
      const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);
      await closeAttached();
      return buildResult({
        answerText: aligned.answerText,
        answerMarkdown: aligned.answerMarkdown,
        runtime: liveRuntime,
      });
    } catch (error) {
      await closeAttached();
      const message = error instanceof Error ? error.message : String(error);
      logger(
        `Existing Chrome reattach failed (${message}); reopening browser to locate the session.`,
      );
      return await recover();
    }
  } catch (error) {
    await releaseRecoveryLock().catch((lockError) => {
      logger(
        `Failed to release recovery lock after reattach error: ${lockError instanceof Error ? lockError.message : String(lockError)}`,
      );
    });
    throw error;
  }
}

export async function retryBrowserRecoveryCleanup(
  runtime: BrowserRuntimeMetadata,
  logger: BrowserLogger,
  deps: Pick<ReattachDeps, "recoveryCleanup" | "recoveryLockPath" | "acquireRecoveryLock"> = {},
): Promise<ReattachFinalizationResult> {
  const lockPath = deps.recoveryLockPath ?? defaultRecoveryLockPath(runtime);
  const recoveryLock = await (deps.acquireRecoveryLock ?? acquireReattachRecoveryLock)(lockPath);
  let result: ReattachFinalizationResult;
  try {
    result = await finalizeRecoveredRuntime(runtime, logger, deps.recoveryCleanup);
  } catch (error) {
    result = pendingFinalization(runtime, error instanceof Error ? error.message : String(error));
  }
  try {
    await recoveryLock.release();
  } catch (error) {
    return pendingFinalization(
      runtime,
      `Cleanup finished but recovery lock release failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return result;
}

async function finalizeRecoveredRuntime(
  runtime: BrowserRuntimeMetadata,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps = {},
): Promise<ReattachFinalizationResult> {
  let current = runtime;
  const backlog = runtime.recoveryCleanupBacklog ?? [];
  for (let index = 0; index < backlog.length; index += 1) {
    const resource = backlog[index];
    if (!resource) continue;
    const result = await finalizeSingleRecoveredRuntime(
      { ...resource, recoveryCleanupBacklog: undefined },
      logger,
      deps,
    );
    if (result.status === "pending") {
      return pendingFinalization(
        { ...current, recoveryCleanupBacklog: backlog.slice(index) },
        result.error,
      );
    }
    current = { ...current, recoveryCleanupBacklog: backlog.slice(index + 1) };
  }
  const result = await finalizeSingleRecoveredRuntime(current, logger, deps);
  if (result.status === "pending") return result;
  const completedRuntime = { ...result.runtime };
  delete completedRuntime.recoveryCleanupBacklog;
  return { status: "completed", runtime: completedRuntime };
}

async function finalizeSingleRecoveredRuntime(
  runtime: BrowserRuntimeMetadata,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps = {},
): Promise<ReattachFinalizationResult> {
  const cleanup = runtime.recoveryCleanup;
  if (!cleanup) return { status: "completed", runtime: clearRecoveryCleanup(runtime) };

  const host = runtime.chromeHost ?? "127.0.0.1";
  const port =
    runtime.chromePort ?? inferPortFromBrowserWSEndpoint(runtime.chromeBrowserWSEndpoint);
  const closeTarget = deps.closeChromeTarget ?? closeChromeTarget;
  const shouldCloseTarget =
    cleanup.ownsTarget && (Boolean(cleanup.closeOwnedTargetOnComplete) || !cleanup.keepBrowser);
  if (shouldCloseTarget) {
    if (!runtime.chromeTargetId || !port) {
      return pendingFinalization(runtime, "Owned Chrome target cleanup metadata is incomplete");
    }
    const closed = await closeTarget({
      host,
      port,
      browserWSEndpoint: runtime.chromeBrowserWSEndpoint,
      targetId: runtime.chromeTargetId,
      logger,
      retainChrome: true,
    });
    if (!closed) return pendingFinalization(runtime, "Chrome target close was not confirmed");
  }

  if (cleanup.transport !== "local" || cleanup.keepBrowser || cleanup.profileKind === "none") {
    return { status: "completed", runtime: clearRecoveryCleanup(runtime) };
  }
  const profileDir = runtime.userDataDir;
  const profileError = validateCleanupProfilePath(runtime, cleanup.profileKind);
  if (!profileDir || profileError) {
    return pendingFinalization(runtime, profileError ?? "Cleanup profile path is missing");
  }

  const terminateChrome =
    deps.terminateRecordedChromeForProfile ?? terminateRecordedChromeForProfile;
  const cleanupProfileState = deps.cleanupStaleProfileState ?? cleanupStaleProfileState;
  if (cleanup.profileKind === "manual-login") {
    const teardown =
      deps.teardownBrowserResourcesIfNoActiveLeases ?? teardownBrowserResourcesIfNoActiveLeases;
    const outcome = await teardown(
      profileDir,
      async () => {
        const termination = await terminateChrome(profileDir, logger);
        if (!isSafeChromeTerminationOutcome(termination)) {
          logger(`[browser] Preserving manual-login profile: ${termination.reason}`);
          return false;
        }
        return cleanupProfileState(profileDir, logger, { lockRemovalMode: "never" });
      },
      { logger },
    );
    if (outcome.status !== "completed") {
      return pendingFinalization(
        runtime,
        outcome.error ?? `Manual-login cleanup preserved resources (${outcome.reason})`,
      );
    }
    return { status: "completed", runtime: clearRecoveryCleanup(runtime) };
  }

  const termination = await terminateChrome(profileDir, logger);
  if (!isSafeChromeTerminationOutcome(termination)) {
    return pendingFinalization(runtime, termination.reason);
  }
  const removed = await removeCleanupProfile(profileDir, deps.removeProfile);
  if (!removed)
    return pendingFinalization(runtime, `Profile removal was not confirmed: ${profileDir}`);
  return { status: "completed", runtime: clearRecoveryCleanup(runtime) };
}

function markRecoveryCleanupPending(runtime: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
  if (!runtime.recoveryCleanup && !runtime.recoveryCleanupBacklog?.length) return runtime;
  return { ...runtime, recoveryCleanupResult: { status: "pending" } };
}

function pendingFinalization(
  runtime: BrowserRuntimeMetadata,
  error: string,
): ReattachFinalizationResult {
  return {
    status: "pending",
    runtime: {
      ...runtime,
      recoveryCleanupResult: { status: "failed", error },
    },
    error,
  };
}

function clearRecoveryCleanup(runtime: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
  const cleared = { ...runtime };
  delete cleared.recoveryCleanup;
  delete cleared.recoveryCleanupResult;
  return cleared;
}

function validateCleanupProfilePath(
  runtime: BrowserRuntimeMetadata,
  profileKind: "temporary" | "manual-login" | "copied" | "none",
): string | null {
  const profileDir = runtime.userDataDir;
  if (!profileDir) return "Cleanup profile path is missing";
  if (!path.isAbsolute(profileDir) || path.resolve(profileDir) !== profileDir) {
    return `Cleanup profile path is not canonical and absolute: ${profileDir}`;
  }
  const root = path.parse(profileDir).root;
  if (profileDir === root || profileDir === path.resolve(os.homedir())) {
    return `Refusing unsafe cleanup profile path: ${profileDir}`;
  }
  if (
    runtime.chromeProfileRoot &&
    path.resolve(runtime.chromeProfileRoot) !== path.resolve(profileDir)
  ) {
    return "Serialized Chrome profile roots disagree";
  }
  if (profileKind !== "temporary" && profileKind !== "copied") return null;
  const basename = path.basename(profileDir);
  if (!basename.startsWith("oracle-browser-") && !basename.startsWith("oracle-reattach-")) {
    return `Refusing unrecognized temporary profile path: ${profileDir}`;
  }
  const allowedRoots = [
    os.tmpdir(),
    "/tmp",
    "/mnt/c/Users/Public/AppData/Local/Temp",
    "/mnt/c/Temp",
    "/mnt/c/Windows/Temp",
  ].map((candidate) => path.resolve(candidate));
  if (!allowedRoots.some((candidate) => isPathWithin(candidate, profileDir))) {
    return `Temporary profile is outside approved runtime roots: ${profileDir}`;
  }
  return null;
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function removeCleanupProfile(
  profileDir: string,
  removeProfile?: (profileDir: string) => Promise<boolean | void>,
): Promise<boolean> {
  if (removeProfile) {
    return (await removeProfile(profileDir)) !== false;
  }
  await rm(profileDir, { recursive: true, force: true });
  return !(await access(profileDir).then(
    () => true,
    () => false,
  ));
}

function defaultRecoveryLockPath(runtime: BrowserRuntimeMetadata): string {
  const identity = JSON.stringify([
    runtime.chromeHost,
    runtime.chromePort,
    runtime.chromeBrowserWSEndpoint,
    runtime.chromeProfileRoot,
    runtime.userDataDir,
    runtime.chromeTargetId,
    runtime.conversationId,
  ]);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return path.join(os.tmpdir(), "oracle-browser-recovery-locks", `${digest}.lock`);
}

async function acquireReattachRecoveryLock(lockPath: string): Promise<ReattachRecoveryLock> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (;;) {
    const lockId = randomUUID();
    try {
      await mkdir(lockPath, { recursive: false });
      try {
        await writeFile(
          path.join(lockPath, "owner.json"),
          `${JSON.stringify({ pid: process.pid, lockId, createdAt: new Date().toISOString() })}\n`,
          { encoding: "utf8", flag: "wx" },
        );
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return {
        path: lockPath,
        release: async () => {
          const owner = await readRecoveryLockOwner(lockPath);
          if (owner.lockId !== lockId) {
            throw new Error(`Recovery lock ownership changed at ${lockPath}`);
          }
          await rm(lockPath, { recursive: true, force: false });
        },
      };
    } catch (error) {
      if (readErrorCode(error) !== "EEXIST") throw error;
      const owner = await readRecoveryLockOwner(lockPath);
      if (isProcessAlive(owner.pid)) {
        throw new Error(`Browser recovery is already in progress (pid ${owner.pid})`);
      }
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, stalePath);
      } catch (renameError) {
        if (readErrorCode(renameError) === "ENOENT") continue;
        throw renameError;
      }
      await rm(stalePath, { recursive: true, force: true });
    }
  }
}

async function readRecoveryLockOwner(lockPath: string): Promise<{ pid: number; lockId: string }> {
  const raw = await readFile(path.join(lockPath, "owner.json"), "utf8");
  const parsed = JSON.parse(raw) as { pid?: unknown; lockId?: unknown };
  if (
    typeof parsed.pid !== "number" ||
    !Number.isFinite(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.lockId !== "string" ||
    parsed.lockId.length === 0
  ) {
    throw new Error(`Invalid browser recovery lock owner at ${lockPath}`);
  }
  return { pid: parsed.pid, lockId: parsed.lockId };
}

function readErrorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

async function refreshAttachRuntime(
  runtime: BrowserRuntimeMetadata,
): Promise<BrowserRuntimeMetadata | null> {
  if (!runtime.chromeProfileRoot) {
    return runtime;
  }
  const host = runtime.chromeHost ?? "127.0.0.1";
  const activePort = await readDevToolsActivePortInfo(runtime.chromeProfileRoot, {
    host,
  });
  if (!activePort) {
    return runtime;
  }
  return {
    ...runtime,
    chromeHost: host,
    chromePort: activePort.port,
    chromeBrowserWSEndpoint: activePort.browserWSEndpoint,
  };
}

function inferPortFromBrowserWSEndpoint(browserWSEndpoint?: string): number | undefined {
  if (!browserWSEndpoint) {
    return undefined;
  }
  try {
    const parsed = new URL(browserWSEndpoint);
    const port = Number.parseInt(parsed.port, 10);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  } catch {
    // ignore malformed ws endpoints and fall back to caller defaults
  }
  return undefined;
}

async function resumeBrowserSessionViaNewChrome(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ReattachCapture> {
  const resolved = resolveBrowserConfig(config ?? {});
  const manualLogin = Boolean(resolved.manualLogin);
  const userDataDir = manualLogin
    ? (resolved.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile"))
    : await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
  if (manualLogin) await mkdir(userDataDir, { recursive: true });

  let fallbackLease: Awaited<ReturnType<typeof acquireBrowserTabLease>> | null = null;
  let chrome: Awaited<ReturnType<typeof launchChrome>> | null = null;
  let client: ChromeClient | null = null;
  const releaseFallbackLease = async (
    onRelease?: (context: { isLastLease: boolean }) => Promise<void>,
  ): Promise<void> => {
    const lease = fallbackLease;
    fallbackLease = null;
    await lease?.release(onRelease ? { onRelease } : undefined);
  };

  try {
    if (manualLogin) {
      fallbackLease = await acquireBrowserTabLease(userDataDir, {
        maxConcurrentTabs: resolved.maxConcurrentTabs,
        timeoutMs: resolved.timeoutMs,
        logger,
        sessionId: `reattach-${process.pid}`,
      });
    }
    chrome = await launchChrome(resolved, userDataDir, logger);
    const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
    await writeChromePid(userDataDir, chrome.pid);
    await fallbackLease?.update({ chromeHost, chromePort: chrome.port });
    client = await connectToChrome(chrome.port, logger, chromeHost);
    const { Network, Page, Runtime, DOM, Target } = client;

    if (Runtime?.enable) await Runtime.enable();
    if (DOM && typeof DOM.enable === "function") await DOM.enable();
    if (!resolved.headless && resolved.hideWindow) {
      await positionChromeWindowOffscreen(client, logger);
    }
    let appliedCookies = 0;
    if (!manualLogin && resolved.cookieSync) {
      appliedCookies = await syncCookies(Network, resolved.url, resolved.chromeProfile, logger, {
        allowErrors: resolved.allowCookieErrors,
        filterNames: resolved.cookieNames ?? undefined,
        inlineCookies: resolved.inlineCookies ?? undefined,
        cookiePath: resolved.chromeCookiePath ?? undefined,
        waitMs: resolved.cookieSyncWaitMs ?? 0,
      });
    }

    await clearStaleChatGptConversationCookies(Network, Target, logger, {
      preserveConversationIds: [
        runtime.conversationId,
        extractConversationIdFromUrl(runtime.tabUrl ?? ""),
        extractConversationIdFromUrl(resolved.url),
      ],
    });

    await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
    await ensureNotBlocked(Runtime, resolved.headless, logger);
    await ensureLoggedIn(Runtime, logger, { appliedCookies });
    if (resolved.url !== CHATGPT_URL) {
      await navigateToChatGPT(Page, Runtime, resolved.url, logger);
      await ensureNotBlocked(Runtime, resolved.headless, logger);
    }
    await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);

    const conversationUrl = buildConversationUrl(runtime, resolved.url);
    if (conversationUrl) {
      logger(`Reopening conversation at ${conversationUrl}`);
      await navigateToChatGPT(Page, Runtime, conversationUrl, logger);
      await ensureNotBlocked(Runtime, resolved.headless, logger);
      await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);
    } else {
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        {
          conversationId:
            runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ""),
          preferProjects:
            resolved.url !== CHATGPT_URL ||
            Boolean(
              runtime.tabUrl &&
              (/\/g\//.test(runtime.tabUrl) || runtime.tabUrl.includes("/project")),
            ),
          promptPreview: deps.promptPreview,
        },
        15_000,
      );
      if (!opened) throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
      await waitForLocationChange(Runtime, 15_000);
    }

    const waitForHydration =
      deps.waitForConversationHydration ?? waitForResumedConversationHydration;
    await waitForHydration(Runtime, resolved.inputTimeoutMs, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl: conversationUrl ?? undefined,
    });
    const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
    const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
    const timeoutMs = resolved.timeoutMs ?? 120_000;
    const minTurnIndex =
      (await readPromptPreviewTurnIndex(Runtime, deps.promptPreview)) ??
      (deps.promptPreview ? null : await readConversationTurnIndex(Runtime, logger));

    let answerText: string;
    let answerMarkdown: string;
    if (resolved.researchMode === "deep") {
      const waitForDeepResearch =
        deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
      const researchResult = await waitForDeepResearch(
        Runtime,
        logger,
        timeoutMs,
        minTurnIndex ?? undefined,
        Page,
        client,
        { requireScopedTargetOwner: true },
      );
      answerText = researchResult.text;
      answerMarkdown = researchResult.text;
    } else {
      const promptEcho = buildPromptEchoMatcher(deps.promptPreview);
      const answer = await waitForResponse(Runtime, timeoutMs, logger, minTurnIndex ?? undefined);
      const recovered = await recoverPromptEcho(
        Runtime,
        answer,
        promptEcho,
        logger,
        minTurnIndex,
        timeoutMs,
      );
      const markdown = (await captureMarkdown(Runtime, recovered.meta, logger)) ?? recovered.text;
      const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);
      answerText = aligned.answerText;
      answerMarkdown = aligned.answerMarkdown;
    }

    await client.close().catch(() => undefined);
    client = null;
    const priorCleanup = runtime.recoveryCleanup
      ? [
          {
            chromePid: runtime.chromePid,
            chromePort: runtime.chromePort,
            chromeHost: runtime.chromeHost,
            chromeBrowserWSEndpoint: runtime.chromeBrowserWSEndpoint,
            chromeProfileRoot: runtime.chromeProfileRoot,
            userDataDir: runtime.userDataDir,
            chromeTargetId: runtime.chromeTargetId,
            recoveryCleanup: runtime.recoveryCleanup,
          },
        ]
      : [];
    const fallbackRuntime: BrowserRuntimeMetadata = {
      ...runtime,
      browserTransport: "cdp",
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      chromeBrowserWSEndpoint: undefined,
      chromeProfileRoot: userDataDir,
      userDataDir,
      chromeTargetId: undefined,
      recoveryCleanup: {
        transport: "local",
        ownsTarget: false,
        profileKind: manualLogin ? "manual-login" : "temporary",
        keepBrowser: Boolean(resolved.keepBrowser),
      },
      recoveryCleanupResult: { status: "pending" },
      recoveryCleanupBacklog: [...(runtime.recoveryCleanupBacklog ?? []), ...priorCleanup],
      controllerPid: process.pid,
    };
    return {
      answerText,
      answerMarkdown,
      runtime: fallbackRuntime,
      finalizeResources: async () => {
        await releaseFallbackLease();
        return finalizeRecoveredRuntime(fallbackRuntime, logger, deps.recoveryCleanup);
      },
      abandonResources: releaseFallbackLease,
    };
  } catch (error) {
    await client?.close().catch(() => undefined);
    if (manualLogin) {
      await releaseFallbackLease(async ({ isLastLease }) => {
        if (!isLastLease || !chrome || resolved.keepBrowser) return;
        let stopped = true;
        try {
          await chrome.kill();
        } catch {
          stopped = false;
        }
        if (!stopped) {
          logger("[browser] Fallback Chrome termination failed; preserving manual-login state.");
          return;
        }
        const cleaned = await cleanupStaleProfileState(userDataDir, logger, {
          lockRemovalMode: "never",
        }).catch(() => false);
        if (!cleaned) {
          logger("[browser] Fallback manual-login cleanup was not confirmed; preserving state.");
        }
      }).catch((releaseError) => {
        logger(
          `[browser] Fallback lease release failed; preserving shared Chrome resources: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
        );
      });
    } else {
      await releaseFallbackLease().catch(() => undefined);
      if (chrome && !resolved.keepBrowser) {
        let stopped = true;
        try {
          await chrome.kill();
        } catch {
          stopped = false;
        }
        if (stopped) {
          await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
        }
      } else if (!chrome) {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    throw error;
  }
}

async function readPromptPreviewTurnIndex(
  Runtime: ChromeClient["Runtime"],
  promptPreview?: string | null,
): Promise<number | null> {
  const preview = promptPreview?.trim();
  if (!preview) {
    return null;
  }
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const needle = ${JSON.stringify(preview.toLowerCase().replace(/\s+/g, " ").slice(0, 120))};
      if (!needle) return null;
      const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const turns = ${buildConversationTurnListExpression()};
      let matched = null;
      for (const [index, node] of turns.entries()) {
        const attr = (node.getAttribute('data-message-author-role') || node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
        const isUser = attr === 'user' || Boolean(node.querySelector('[data-message-author-role="user"]'));
        if (!isUser) continue;
        const text = normalize(node.innerText || node.textContent || '');
        if (text.length > 0 && (text.includes(needle) || needle.includes(text.slice(0, needle.length)))) {
          matched = index;
        }
      }
      return matched;
    })()`,
    returnByValue: true,
  });
  return typeof result?.value === "number" ? result.value : null;
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  openConversationFromSidebar,
  readPromptPreviewTurnIndex,
  finalizeRecoveredRuntime,
};
