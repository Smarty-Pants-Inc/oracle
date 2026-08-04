import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
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
import type { BrowserCaptureFinalizationResult, BrowserLogger, ChromeClient } from "./types.js";
import {
  launchChrome,
  createChromePageTarget,
  positionChromeWindowOffscreen,
  connectToRemoteChromeTarget,
  listRemoteChromeTargets,
  closeChromeTarget,
  type RemoteChromeConnection,
} from "./chromeLifecycle.js";
import {
  acquireManualChromeOwner,
  type BrowserChrome,
  type ManualChromeOwnerSource,
} from "./manualChromeOwner.js";
import { resolveBrowserConfig } from "./config.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import { CHATGPT_URL } from "./constants.js";
import {
  cleanupStaleProfileState,
  isSafeChromeTerminationOutcome,
  terminateRecordedChromeForProfile,
  writeChromePid,
  writeChromeProcessIdentity,
} from "./profileState.js";
import {
  acquireBrowserTabLease,
  teardownBrowserResourcesIfNoActiveLeases,
  type BrowserTabLease,
} from "./tabLeaseRegistry.js";
import {
  acquireCrashRecoverableFilesystemLock,
  FilesystemLockBusyError,
} from "./filesystemLock.js";
import { readDevToolsActivePortInfo } from "./detect.js";
import {
  extractConversationIdFromUrl,
  buildConversationUrl,
  withTimeout,
  openConversationFromSidebar,
  openConversationFromSidebarWithRetry,
  waitForLocationChange,
  buildPromptEchoMatcher,
  recoverPromptEcho,
  alignPromptEchoMarkdown,
  type TargetInfoLite,
} from "./reattachHelpers.js";
import { waitForDeepResearchCompletion } from "./actions/deepResearch.js";
import { isRecoverableChatGptConversationUrl } from "./reattachability.js";

export interface ReattachCleanupDeps {
  closeChromeTarget?: typeof closeChromeTarget;
  terminateRecordedChromeForProfile?: typeof terminateRecordedChromeForProfile;
  cleanupStaleProfileState?: typeof cleanupStaleProfileState;
  teardownBrowserResourcesIfNoActiveLeases?: typeof teardownBrowserResourcesIfNoActiveLeases;
  removeProfile?: (profileDir: string) => Promise<boolean>;
}

export interface ReattachRecoveryLock {
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
  acquireManualChromeOwner?: typeof acquireManualChromeOwner;
  createRecoveryTarget?: typeof createChromePageTarget;
  connectRecoveryTarget?: typeof connectToRemoteChromeTarget;
  recoverSession?: (
    runtime: BrowserRuntimeMetadata,
    config: BrowserSessionConfig | undefined,
  ) => Promise<ReattachCapture>;
  promptPreview?: string;
  recoveryCleanup?: ReattachCleanupDeps;
  recoveryLockPath?: string;
  acquireRecoveryLock?: (lockPath: string) => Promise<ReattachRecoveryLock>;
}

export type ReattachFinalizationResult = BrowserCaptureFinalizationResult;

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
  const promptEpoch = requireCommittedPromptEpoch(runtime);
  const minAssistantTurnIndex = promptEpoch.verifiedUserTurnIndex + 1;
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

  const buildResult = (
    capture: ReattachCapture,
    authoritativeRuntime: BrowserRuntimeMetadata = runtime,
  ): ReattachResult => {
    const runtimeForCapture = capture.runtime ?? authoritativeRuntime;
    const capturedRuntime = markRecoveryCleanupPending(runtimeForCapture);
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
              : await finalizeRecoveredRuntime(runtimeForCapture, logger, deps.recoveryCleanup);
          } catch (error) {
            result = pendingFinalization(
              runtimeForCapture,
              error instanceof Error ? error.message : String(error),
            );
          }
          try {
            await releaseRecoveryLock();
          } catch (error) {
            return pendingFinalization(
              runtimeForCapture,
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

  const recover = async (
    authoritativeRuntime: BrowserRuntimeMetadata = runtime,
  ): Promise<ReattachResult> => {
    const capture = await recoverSession(authoritativeRuntime, config);
    return buildResult(capture, authoritativeRuntime);
  };

  try {
    if (!runtime.chromePort && !runtime.chromeBrowserWSEndpoint) {
      logger("No running Chrome detected; reopening browser to locate the session.");
      return await recover();
    }

    let liveRuntime = runtime;
    try {
      liveRuntime = (await refreshAttachRuntime(runtime).catch(() => runtime)) ?? runtime;
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
      const targetList = await listTargets();
      const explicitTabRef = config?.browserTabRef?.trim() || undefined;
      const target = pickTarget(targetList, liveRuntime, explicitTabRef);
      const targetId = target?.targetId ?? target?.id;
      if (!targetId) {
        liveRuntime = { ...liveRuntime, chromeTargetId: undefined };
        throw new Error(
          explicitTabRef
            ? `Explicit browser tab ${explicitTabRef} is unavailable.`
            : "Stored Chrome target is unavailable or no longer matches the committed conversation.",
        );
      }
      liveRuntime = {
        ...liveRuntime,
        chromeTargetId: targetId,
        recoveryCleanup:
          explicitTabRef && liveRuntime.recoveryCleanup
            ? { ...liveRuntime.recoveryCleanup, ownsTarget: false }
            : liveRuntime.recoveryCleanup,
      };
      const connection = deps.connect
        ? await (async () => {
            const client = await deps.connect?.(
              browserWSEndpoint
                ? { target: browserWSEndpoint, local: true, targetId }
                : { host, port, target: targetId },
            );
            if (!client) throw new Error("Chrome target connection returned no client.");
            return { client, close: () => client.close() };
          })()
        : await connectToRemoteChromeTarget(host, port ?? 9222, logger, {
            browserWSEndpoint,
            targetId,
            closeTargetOnDispose: false,
          });
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
        if (extractRecoverableConversationId(href) === promptEpoch.conversationId) return;
        const opened = await openConversationFromSidebarWithRetry(
          Runtime,
          {
            conversationId: promptEpoch.conversationId,
            preferProjects: true,
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
      const expectedConversationUrl = buildCommittedConversationUrl(
        runtime,
        resolveBrowserConfig(config ?? {}).url,
        promptEpoch.conversationId,
      );
      await waitForHydration(Runtime, timeoutMs, logger, {
        requirePriorTurns: true,
        requirePromptReady: false,
        expectedConversationUrl: expectedConversationUrl ?? undefined,
      });
      const minTurnIndex = minAssistantTurnIndex;
      if (config?.researchMode === "deep") {
        const waitForDeepResearch =
          deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
        const researchResult = await withTimeout(
          waitForDeepResearch(Runtime, logger, timeoutMs, minTurnIndex, Page, client, {
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
      const promptEcho = buildPromptEchoMatcher();
      const answer = await withTimeout(
        waitForResponse(Runtime, timeoutMs, logger, minTurnIndex),
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
      return await recover(liveRuntime);
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
  const processIdentity = runtime.chromeProcessIdentity;
  if (!processIdentity) {
    return pendingFinalization(runtime, "Chrome process identity cleanup metadata is missing");
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
        const termination = await terminateChrome(profileDir, processIdentity, logger);
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

  const termination = await terminateChrome(profileDir, processIdentity, logger);
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
  removeProfile?: (profileDir: string) => Promise<boolean>,
): Promise<boolean> {
  if (removeProfile) {
    return (await removeProfile(profileDir)) === true;
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
  try {
    return await acquireCrashRecoverableFilesystemLock(lockPath);
  } catch (error) {
    if (error instanceof FilesystemLockBusyError) {
      const owner = error.owner ? ` (pid ${error.owner.pid})` : "";
      throw new Error(`Browser recovery is already in progress${owner}`);
    }
    throw error;
  }
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

function pickTarget(
  targets: TargetInfoLite[],
  runtime: Pick<BrowserRuntimeMetadata, "chromeTargetId" | "tabUrl" | "conversationId">,
  browserTabRef?: string,
): TargetInfoLite | undefined {
  if (!Array.isArray(targets) || targets.length === 0) return undefined;
  const targetId = (target: TargetInfoLite): string | undefined => target.targetId ?? target.id;
  const conversationId =
    runtime.conversationId?.trim() || extractRecoverableConversationId(runtime.tabUrl);
  if (!conversationId) return undefined;
  const matchesConversation = (target: TargetInfoLite): boolean =>
    extractRecoverableConversationId(target.url) === conversationId;
  if (browserTabRef) {
    if (browserTabRef.toLowerCase() === "current") return undefined;
    const exactId = targets.find((target) => targetId(target) === browserTabRef);
    if (exactId) return matchesConversation(exactId) ? exactId : undefined;
    const exactUrls = targets.filter(
      (target) => target.url === browserTabRef && matchesConversation(target),
    );
    if (exactUrls.length === 1) return exactUrls[0];
    if (browserTabRef !== conversationId) return undefined;
    const exactConversations = targets.filter(matchesConversation);
    return exactConversations.length === 1 ? exactConversations[0] : undefined;
  }
  if (!runtime.chromeTargetId) return undefined;
  const exactTarget = targets.find((target) => targetId(target) === runtime.chromeTargetId);
  return exactTarget && matchesConversation(exactTarget) ? exactTarget : undefined;
}

function extractRecoverableConversationId(
  candidate: string | null | undefined,
): string | undefined {
  return isRecoverableChatGptConversationUrl(candidate)
    ? extractConversationIdFromUrl(candidate ?? "")
    : undefined;
}

function buildCommittedConversationUrl(
  runtime: Pick<BrowserRuntimeMetadata, "tabUrl" | "conversationId">,
  baseUrl: string,
  conversationId: string,
): string | null {
  if (extractRecoverableConversationId(runtime.tabUrl) === conversationId) {
    return runtime.tabUrl ?? null;
  }
  const configuredUrl = buildConversationUrl({ conversationId }, baseUrl);
  if (extractRecoverableConversationId(configuredUrl) === conversationId) return configuredUrl;
  const canonicalUrl = buildConversationUrl({ conversationId }, CHATGPT_URL);
  return extractRecoverableConversationId(canonicalUrl) === conversationId ? canonicalUrl : null;
}

function requireCommittedPromptEpoch(
  runtime: BrowserRuntimeMetadata,
): Extract<NonNullable<BrowserRuntimeMetadata["promptEpoch"]>, { status: "committed" }> {
  const epoch = runtime.promptEpoch;
  if (!epoch || epoch.status !== "committed") {
    throw new Error("Browser reattach requires a committed prompt epoch.");
  }
  if (
    typeof epoch.epochId !== "string" ||
    !epoch.epochId.trim() ||
    typeof epoch.promptSha256 !== "string" ||
    !epoch.promptSha256.trim() ||
    !Number.isInteger(epoch.baselineTurns) ||
    epoch.baselineTurns < 0 ||
    typeof epoch.conversationId !== "string" ||
    !epoch.conversationId.trim() ||
    !Number.isInteger(epoch.verifiedUserTurnIndex) ||
    epoch.verifiedUserTurnIndex < epoch.baselineTurns ||
    !Number.isInteger(epoch.followUpOrdinal) ||
    epoch.followUpOrdinal < 0 ||
    !Number.isInteger(epoch.remainingFollowUps) ||
    epoch.remainingFollowUps < 0
  ) {
    throw new Error("Browser reattach prompt epoch is invalid.");
  }
  if (epoch.remainingFollowUps > 0) {
    throw new Error(
      "Browser reattach cannot complete while committed follow-up prompts remain pending.",
    );
  }
  const explicitConversationId = runtime.conversationId?.trim();
  const tabConversationId = extractConversationIdFromUrl(runtime.tabUrl ?? "");
  if (tabConversationId && !isRecoverableChatGptConversationUrl(runtime.tabUrl)) {
    throw new Error("Browser reattach stored tab URL is not a recoverable ChatGPT conversation.");
  }
  const locators = [explicitConversationId, tabConversationId].filter((value): value is string =>
    Boolean(value),
  );
  if (locators.length === 0) {
    throw new Error("Browser reattach has no conversation locator for its prompt epoch.");
  }
  if (locators.some((conversationId) => conversationId !== epoch.conversationId)) {
    throw new Error("Browser reattach prompt epoch does not match the stored conversation.");
  }
  return epoch;
}

function buildRecoveryCleanupBacklog(
  runtime: BrowserRuntimeMetadata,
): NonNullable<BrowserRuntimeMetadata["recoveryCleanupBacklog"]> {
  const backlog = [...(runtime.recoveryCleanupBacklog ?? [])];
  if (runtime.recoveryCleanup) {
    backlog.push({
      chromePid: runtime.chromePid,
      chromeProcessIdentity: runtime.chromeProcessIdentity,
      chromePort: runtime.chromePort,
      chromeHost: runtime.chromeHost,
      chromeBrowserWSEndpoint: runtime.chromeBrowserWSEndpoint,
      chromeProfileRoot: runtime.chromeProfileRoot,
      userDataDir: runtime.userDataDir,
      chromeTargetId: runtime.chromeTargetId,
      recoveryCleanup: runtime.recoveryCleanup,
    });
  }
  return backlog;
}

async function createOwnedRecoveryTargetConnection(
  chrome: Pick<BrowserChrome, "host" | "port">,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<RemoteChromeConnection> {
  const host = chrome.host ?? "127.0.0.1";
  const createTarget = deps.createRecoveryTarget ?? createChromePageTarget;
  const targetId = await createTarget(chrome.port, logger, host);
  if (!targetId) {
    throw new Error("Unable to create a dedicated Chrome target for browser recovery.");
  }

  let connection: RemoteChromeConnection | null = null;
  try {
    connection = await (deps.connectRecoveryTarget ?? connectToRemoteChromeTarget)(
      host,
      chrome.port,
      logger,
      { targetId, closeTargetOnDispose: false },
    );
    if (connection.targetId !== targetId) {
      throw new Error(
        `Recovery target connection resolved ${connection.targetId} instead of created target ${targetId}.`,
      );
    }
    return { ...connection, targetId, ownership: "created" };
  } catch (error) {
    await connection?.close().catch(() => undefined);
    const closeOwnedTarget = deps.recoveryCleanup?.closeChromeTarget ?? closeChromeTarget;
    const closed = await closeOwnedTarget({
      host,
      port: chrome.port,
      targetId,
      logger,
    }).catch(() => false);
    if (!closed) logger(`[browser] Failed to close unused recovery target ${targetId}.`);
    throw error;
  }
}

async function resumeBrowserSessionViaNewChrome(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ReattachCapture> {
  const resolved = resolveBrowserConfig(config ?? {});
  const promptEpoch = requireCommittedPromptEpoch(runtime);
  const minTurnIndex = promptEpoch.verifiedUserTurnIndex + 1;
  const manualLogin = Boolean(resolved.manualLogin);
  const userDataDir = manualLogin
    ? (resolved.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile"))
    : await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
  if (manualLogin) await mkdir(userDataDir, { recursive: true });

  let fallbackLease: BrowserTabLease | null = null;
  let chrome: BrowserChrome | null = null;
  let chromeOwnerSource: ManualChromeOwnerSource | null = null;
  let fallbackTargetId: string | null = null;
  let client: ChromeClient | null = null;
  let closeFallbackConnection: (() => Promise<void>) | null = null;
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
    if (manualLogin) {
      const owner = await (deps.acquireManualChromeOwner ?? acquireManualChromeOwner)(
        userDataDir,
        resolved,
        logger,
        `reattach-${process.pid}`,
      );
      chrome = owner.chrome;
      chromeOwnerSource = owner.source;
    } else {
      chrome = await launchChrome(resolved, userDataDir, logger);
      chromeOwnerSource = "launched";
      await writeChromePid(userDataDir, chrome.pid);
      await writeChromeProcessIdentity(userDataDir, chrome.processIdentity);
    }
    const chromeHost = chrome.host ?? "127.0.0.1";
    const recoveryConnection = await createOwnedRecoveryTargetConnection(chrome, logger, deps);
    const recoveryTargetId = recoveryConnection.targetId;
    fallbackTargetId = recoveryTargetId;
    client = recoveryConnection.client;
    closeFallbackConnection = recoveryConnection.close;
    await fallbackLease?.update({
      chromeHost,
      chromePort: chrome.port,
      chromeTargetId: recoveryTargetId,
    });
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
        promptEpoch.conversationId,
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

    const conversationUrl = buildCommittedConversationUrl(
      runtime,
      resolved.url,
      promptEpoch.conversationId,
    );
    if (conversationUrl) {
      logger(`Reopening conversation at ${conversationUrl}`);
      await navigateToChatGPT(Page, Runtime, conversationUrl, logger);
      await ensureNotBlocked(Runtime, resolved.headless, logger);
      await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);
    } else {
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        {
          conversationId: promptEpoch.conversationId,
          preferProjects:
            resolved.url !== CHATGPT_URL ||
            Boolean(
              runtime.tabUrl &&
              (/\/g\//.test(runtime.tabUrl) || runtime.tabUrl.includes("/project")),
            ),
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

    let answerText: string;
    let answerMarkdown: string;
    if (resolved.researchMode === "deep") {
      const waitForDeepResearch =
        deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
      const researchResult = await waitForDeepResearch(
        Runtime,
        logger,
        timeoutMs,
        minTurnIndex,
        Page,
        client,
        { requireScopedTargetOwner: true },
      );
      answerText = researchResult.text;
      answerMarkdown = researchResult.text;
    } else {
      const promptEcho = buildPromptEchoMatcher();
      const answer = await waitForResponse(Runtime, timeoutMs, logger, minTurnIndex);
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

    const closeConnection = closeFallbackConnection;
    if (!closeConnection) throw new Error("Recovery target connection cleanup is unavailable.");
    await closeConnection().catch(() => undefined);
    closeFallbackConnection = null;
    client = null;
    const fallbackRuntime: BrowserRuntimeMetadata = {
      ...runtime,
      browserTransport: "cdp",
      chromePid: chrome.pid,
      chromeProcessIdentity: chrome.processIdentity,
      chromePort: chrome.port,
      chromeHost,
      chromeBrowserWSEndpoint: undefined,
      chromeProfileRoot: userDataDir,
      userDataDir,
      chromeTargetId: recoveryTargetId,
      recoveryCleanup: {
        transport: "local",
        ownsTarget: true,
        profileKind: manualLogin ? "manual-login" : "temporary",
        keepBrowser: Boolean(resolved.keepBrowser),
      },
      recoveryCleanupResult: { status: "pending" },
      recoveryCleanupBacklog: buildRecoveryCleanupBacklog(runtime),
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
    if (closeFallbackConnection) {
      await closeFallbackConnection().catch(() => undefined);
      closeFallbackConnection = null;
    } else {
      await client?.close().catch(() => undefined);
    }
    client = null;
    if (chrome && fallbackTargetId) {
      const closeOwnedTarget = deps.recoveryCleanup?.closeChromeTarget ?? closeChromeTarget;
      const closed = await closeOwnedTarget({
        host: chrome.host ?? "127.0.0.1",
        port: chrome.port,
        targetId: fallbackTargetId,
        logger,
      }).catch(() => false);
      if (!closed) logger(`[browser] Failed to close recovery target ${fallbackTargetId}.`);
    }
    if (manualLogin) {
      await releaseFallbackLease(async ({ isLastLease }) => {
        if (!isLastLease || !chrome || resolved.keepBrowser || chromeOwnerSource !== "launched")
          return;
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

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  openConversationFromSidebar,
  finalizeRecoveredRuntime,
  buildRecoveryCleanupBacklog,
  createOwnedRecoveryTargetConnection,
};
