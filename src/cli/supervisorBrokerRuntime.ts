import CDP from "chrome-remote-interface";
import os from "node:os";
import path from "node:path";
import type { BrowserRuntimeMetadata, SessionMetadata } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import {
  connectToRemoteChromeTarget,
  listRemoteChromeTargets,
} from "../browser/chromeLifecycle.js";
import {
  chromePidMatchesUserDataDir,
  readChromePid,
  resolveChromePidForUserDataDir,
  verifyDevToolsReachable,
} from "../browser/profileState.js";
import { readDevToolsActivePortInfo } from "../browser/detect.js";
import {
  conversationHrefMatchesConfiguredScope,
  extractConversationIdFromUrl,
  isAttachableChatTarget,
  pickTarget,
  runtimeHasReusableIdentity,
  runtimeRequiresSpecificTarget,
  type TargetInfoLite,
} from "../browser/reattachHelpers.js";
import type { BrowserLogger, ChromeClient } from "../browser/types.js";
import { normalizeChatgptUrl } from "../browser/utils.js";

const noopLogger: BrowserLogger = Object.assign((_: string) => {}, { verbose: false });
const SUPERVISOR_BROWSER_PROFILE_DIR = path.join(os.homedir(), ".oracle", "browser-profile-hidden");

export interface SupervisorRuntimeContext {
  sessionId: string;
  runtime: BrowserRuntimeMetadata;
}

export interface SupervisorRuntimeConnection {
  client: ChromeClient;
  close: () => Promise<void>;
  host: string;
  port: number;
  targetId?: string;
}

function parseSessionTimestamp(meta: SessionMetadata): number {
  const candidate = meta.startedAt ?? meta.completedAt ?? meta.createdAt;
  const parsed = Date.parse(candidate ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function processIsAlive(pid: number | null | undefined): boolean {
  if (!Number.isFinite(pid) || (pid ?? 0) <= 0) {
    return false;
  }
  try {
    process.kill(Math.trunc(pid as number), 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : null;
    return code === "EPERM";
  }
}

function runtimeControllerIsAlive(meta: SessionMetadata): boolean {
  const controllerPid = meta.browser?.runtime?.controllerPid;
  if (!Number.isFinite(controllerPid) || (controllerPid ?? 0) <= 0) {
    return true;
  }
  return processIsAlive(controllerPid);
}

function supervisorRuntimeIsReusableNow(meta: SessionMetadata): boolean {
  const sessionStatus = String(meta.status ?? "").toLowerCase();
  const responseStatus = String(meta.response?.status ?? "").toLowerCase();
  const incompleteReason = meta.response?.incompleteReason?.trim();
  const completed =
    sessionStatus === "completed" || (!sessionStatus && responseStatus === "completed");
  return completed && (!responseStatus || responseStatus === "completed") && !incompleteReason;
}

function runtimeReusePriority(meta: SessionMetadata): number {
  switch (meta.status) {
    case "completed":
      return 1;
    default:
      return 0;
  }
}

function supervisorRuntimePreference(meta: SessionMetadata): number {
  return isOwnedSupervisorRuntime(meta) ? 1 : 0;
}

function supervisorRuntimeBindingPreference(meta: SessionMetadata): number {
  return meta.supervisorThread?.conversationId?.trim() ? 0 : 1;
}

function hasReusableRuntime(meta: SessionMetadata): meta is SessionMetadata & {
  browser: { runtime: BrowserRuntimeMetadata };
} {
  const runtime = meta.browser?.runtime;
  return Boolean(runtime && (runtime.chromePort || runtime.chromeBrowserWSEndpoint));
}

function configuredSupervisorScopeUrl(meta: SessionMetadata): string | undefined {
  const configuredProjectUrl =
    meta.browser?.config?.supervisorChatgptUrl?.trim() ??
    meta.browser?.config?.chatgptUrl?.trim() ??
    meta.browser?.config?.url?.trim();
  if (!configuredProjectUrl) {
    return undefined;
  }
  try {
    return normalizeChatgptUrl(configuredProjectUrl, "https://chatgpt.com/");
  } catch {
    return undefined;
  }
}

function runtimeMatchesConfiguredProjectScope(meta: SessionMetadata): boolean {
  const configuredProjectUrl = configuredSupervisorScopeUrl(meta);
  const tabUrl = meta.browser?.runtime?.tabUrl?.trim();
  return Boolean(
    configuredProjectUrl &&
    tabUrl &&
    conversationHrefMatchesConfiguredScope(tabUrl, configuredProjectUrl),
  );
}

function isOwnedSupervisorRuntime(meta: SessionMetadata): meta is SessionMetadata & {
  browser: {
    runtime: BrowserRuntimeMetadata;
    config: Exclude<NonNullable<SessionMetadata["browser"]>["config"], undefined>;
  };
} {
  const config = meta.browser?.config;
  if (!config) {
    return false;
  }
  const configuredProfileDir = config.manualLoginProfileDir?.trim();
  const runtimeProfileDir = meta.browser?.runtime?.userDataDir?.trim();
  const expectedProfileDir = configuredProfileDir || runtimeProfileDir;
  if (!expectedProfileDir) {
    return false;
  }
  return (
    hasReusableRuntime(meta) &&
    config.manualLogin === true &&
    config.keepBrowser === true &&
    config.hideWindow === true &&
    config.attachRunning !== true &&
    config.launcher !== "carbonyl" &&
    config.remoteChrome == null &&
    path.resolve(expectedProfileDir) == SUPERVISOR_BROWSER_PROFILE_DIR &&
    Boolean(configuredSupervisorScopeUrl(meta))
  );
}

function sortReusableRuntimeCandidates(
  metas: SessionMetadata[],
): (SessionMetadata & { browser: { runtime: BrowserRuntimeMetadata } })[] {
  return metas
    .filter(
      (meta): meta is SessionMetadata & { browser: { runtime: BrowserRuntimeMetadata } } =>
        isOwnedSupervisorRuntime(meta) && supervisorRuntimeIsReusableNow(meta),
    )
    .sort(
      (left, right) =>
        supervisorRuntimePreference(right) - supervisorRuntimePreference(left) ||
        supervisorRuntimeBindingPreference(right) - supervisorRuntimeBindingPreference(left) ||
        runtimeReusePriority(right) - runtimeReusePriority(left) ||
        parseSessionTimestamp(right) - parseSessionTimestamp(left),
    );
}

function pickReusableRuntimeCandidate(
  metas: SessionMetadata[],
): (SessionMetadata & { browser: { runtime: BrowserRuntimeMetadata } }) | undefined {
  return sortReusableRuntimeCandidates(metas)[0];
}

async function resolveMutableSupervisorRuntimeAnchorSessionId(
  meta: SessionMetadata,
  readSession: typeof sessionStore.readSession = sessionStore.readSession.bind(sessionStore),
): Promise<string> {
  let current = meta;
  const visited = new Set<string>();
  while (current.supervisorThread?.conversationId?.trim()) {
    const currentId = current.id?.trim();
    if (!currentId) {
      throw new Error(
        "Supervisor runtime anchor resolution encountered a bound session without an id.",
      );
    }
    if (visited.has(currentId)) {
      throw new Error(
        `Supervisor runtime anchor resolution detected a followup cycle at session ${currentId}.`,
      );
    }
    visited.add(currentId);
    const parentSessionId = current.options?.followupSessionId?.trim();
    if (!parentSessionId) {
      throw new Error(
        `Session ${currentId} is bound to Oracle conversation ${current.supervisorThread.conversationId} but has no reusable parent runtime session.`,
      );
    }
    const parent = await readSession(parentSessionId);
    if (!parent) {
      throw new Error(
        `Session ${currentId} is bound to Oracle conversation ${current.supervisorThread.conversationId} but parent session ${parentSessionId} was not found.`,
      );
    }
    if (!hasReusableRuntime(parent) || !isOwnedSupervisorRuntime(parent)) {
      throw new Error(
        `Session ${currentId} is bound to Oracle conversation ${current.supervisorThread.conversationId} but parent session ${parentSessionId} is not a reusable Oracle-owned hidden runtime.`,
      );
    }
    if (!supervisorRuntimeIsReusableNow(parent)) {
      throw new Error(
        `Session ${currentId} is bound to Oracle conversation ${current.supervisorThread.conversationId} but parent session ${parentSessionId} is not reusable yet.`,
      );
    }
    current = parent;
  }
  return current.id;
}

async function refreshOwnedSupervisorRuntime(
  meta: SessionMetadata & { browser: { runtime: BrowserRuntimeMetadata } },
): Promise<BrowserRuntimeMetadata> {
  const runtime = meta.browser.runtime;
  if (!isOwnedSupervisorRuntime(meta)) {
    throw new Error(
      "Refusing to attach supervisor controls to a browser runtime that is not the Oracle-owned hidden browser profile.",
    );
  }
  const config = meta.browser.config;
  const configuredProjectUrl = configuredSupervisorScopeUrl(meta);
  const configuredProfileDir = config.manualLoginProfileDir?.trim();
  const runtimeProfileDir = runtime.userDataDir?.trim();
  const expectedProfileDir = configuredProfileDir || runtimeProfileDir;
  if (!expectedProfileDir) {
    throw new Error(
      "Refusing to attach supervisor controls without an owned hidden browser profile directory.",
    );
  }
  const normalizedProfileDir = path.resolve(expectedProfileDir);
  if (normalizedProfileDir != SUPERVISOR_BROWSER_PROFILE_DIR) {
    throw new Error(
      "Refusing to attach: cached Oracle runtime profile is not the dedicated hidden supervisor profile.",
    );
  }
  if (runtimeProfileDir && path.resolve(runtimeProfileDir) !== normalizedProfileDir) {
    throw new Error(
      "Refusing to attach: cached Oracle runtime profile does not match the owned hidden browser profile.",
    );
  }
  if (!configuredProjectUrl) {
    throw new Error(
      "Refusing to attach: owned Oracle hidden browser runtime is missing a configured ChatGPT scope.",
    );
  }
  if (!runtimeMatchesConfiguredProjectScope(meta)) {
    throw new Error(
      "Refusing to attach: cached Oracle hidden browser tab is outside the configured ChatGPT scope.",
    );
  }
  if (!runtimeHasReusableIdentity(runtime)) {
    throw new Error(
      "Refusing to attach supervisor controls: cached Oracle hidden browser runtime is missing conversation identity metadata.",
    );
  }
  const devtoolsInfo = await readDevToolsActivePortInfo(normalizedProfileDir, {
    host: runtime.chromeHost ?? "127.0.0.1",
  });
  const discoveredChromePid = await readChromePid(normalizedProfileDir);
  if (
    discoveredChromePid &&
    !(await chromePidMatchesUserDataDir(discoveredChromePid, normalizedProfileDir))
  ) {
    throw new Error(
      "Refusing to attach: the process holding the Oracle hidden browser profile is not an Oracle-owned Chrome instance.",
    );
  }
  const chromePid = await resolveChromePidForUserDataDir(normalizedProfileDir, runtime.chromePid);
  if (!devtoolsInfo) {
    throw new Error(
      "Owned Oracle hidden browser profile is not exposing DevTools. Run another Oracle browser turn to relaunch the hidden profile instead of attaching elsewhere.",
    );
  }
  return {
    ...runtime,
    chromePid: chromePid ?? undefined,
    chromeHost: runtime.chromeHost ?? "127.0.0.1",
    chromePort: devtoolsInfo.port,
    chromeBrowserWSEndpoint: devtoolsInfo.browserWSEndpoint,
    userDataDir: normalizedProfileDir,
  };
}

function resolvePort(runtime: BrowserRuntimeMetadata): number | null {
  if (runtime.chromePort && Number.isFinite(runtime.chromePort) && runtime.chromePort > 0) {
    return runtime.chromePort;
  }
  const endpoint = runtime.chromeBrowserWSEndpoint;
  if (!endpoint) {
    return null;
  }
  try {
    const parsed = new URL(endpoint);
    const port = Number.parseInt(parsed.port, 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function browserWSEndpointLooksStale(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Unexpected server response:\s*404|ECONNREFUSED|ECONNRESET|socket hang up|missing browser websocket endpoint/i.test(
    message,
  );
}

function pickSupervisorRuntimeTarget(
  targets: TargetInfoLite[],
  runtime: BrowserRuntimeMetadata,
  strictTargetMatch: boolean,
): TargetInfoLite | undefined {
  const requireMatch = strictTargetMatch || runtimeRequiresSpecificTarget(runtime);
  return pickTarget(targets, runtime, { requireMatch });
}

function normalizeComparableUrl(url: string | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function inferSupervisorRuntimeScopeUrl(runtime: BrowserRuntimeMetadata): string | undefined {
  const tabUrl = runtime.tabUrl?.trim();
  if (!tabUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(tabUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const projectShellPath = pathname.match(/^(\/g\/[^/]+\/project)$/i)?.[1];
    if (projectShellPath) {
      return `${parsed.origin}${projectShellPath}`;
    }
    const projectConversationSlug = pathname.match(
      /^\/g\/([^/]+?)(?:-oracle)?(?:\/project)?\/c\/[a-zA-Z0-9-]+$/i,
    )?.[1];
    if (projectConversationSlug) {
      return `${parsed.origin}/g/${projectConversationSlug}/project`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function pickSafeSupervisorRecoveryTarget(
  targets: TargetInfoLite[],
  runtime: BrowserRuntimeMetadata,
): TargetInfoLite | undefined {
  const scopeUrl = inferSupervisorRuntimeScopeUrl(runtime);
  if (!scopeUrl) {
    return undefined;
  }
  const scopeTargets = targets.filter(
    (target) =>
      isAttachableChatTarget(target) &&
      Boolean(target.url) &&
      conversationHrefMatchesConfiguredScope(target.url ?? "", scopeUrl),
  );
  if (scopeTargets.length === 0) {
    return undefined;
  }
  const normalizedScopeUrl = normalizeComparableUrl(scopeUrl);
  const pageTargets = scopeTargets.filter((target) => target.type === "page");
  const scopeShellPages = pageTargets.filter(
    (target) => normalizeComparableUrl(target.url) === normalizedScopeUrl,
  );
  if (scopeShellPages.length === 1) {
    return scopeShellPages[0];
  }
  return undefined;
}

function pickConnectableSupervisorRuntimeTarget(
  targets: TargetInfoLite[],
  runtime: BrowserRuntimeMetadata,
  strictTargetMatch: boolean,
): TargetInfoLite | undefined {
  return (
    pickSupervisorRuntimeTarget(targets, runtime, strictTargetMatch) ??
    pickSafeSupervisorRecoveryTarget(targets, runtime)
  );
}

async function readConnectedTargetInfo(
  client: ChromeClient,
  fallback: TargetInfoLite,
  options?: { requireVerification?: boolean },
): Promise<TargetInfoLite> {
  try {
    const info = await client.Target?.getTargetInfo?.({});
    if (info?.targetInfo) {
      return {
        targetId: info.targetInfo.targetId ?? fallback.targetId,
        type: info.targetInfo.type ?? fallback.type,
        url: info.targetInfo.url ?? fallback.url,
      };
    }
    if (options?.requireVerification) {
      throw new Error("Target.getTargetInfo returned no target metadata");
    }
  } catch {
    if (options?.requireVerification) {
      throw new Error("Target.getTargetInfo failed while verifying the cached target");
    }
  }
  return fallback;
}

function connectedSupervisorTargetMatches(
  runtime: BrowserRuntimeMetadata,
  target: TargetInfoLite,
): boolean {
  const runtimeConversationId = runtime.conversationId?.trim();
  const targetConversationId = extractConversationIdFromUrl(target.url ?? "")?.trim();
  if (
    runtimeConversationId &&
    targetConversationId &&
    targetConversationId !== runtimeConversationId
  ) {
    return false;
  }
  return Boolean(pickSupervisorRuntimeTarget([target], runtime, true));
}

function connectedTargetMatchesExpectedTarget(
  expected: TargetInfoLite,
  actual: TargetInfoLite,
): boolean {
  if (
    expected.targetId?.trim() &&
    actual.targetId?.trim() &&
    expected.targetId !== actual.targetId
  ) {
    return false;
  }
  const expectedUrl = normalizeComparableUrl(expected.url);
  const actualUrl = normalizeComparableUrl(actual.url);
  return !expectedUrl || !actualUrl || expectedUrl === actualUrl;
}

async function pickReachableRuntimeCandidate(
  metas: SessionMetadata[],
  probe: typeof verifyDevToolsReachable = verifyDevToolsReachable,
  listTargets: typeof listRemoteChromeTargets = listRemoteChromeTargets,
): Promise<(SessionMetadata & { browser: { runtime: BrowserRuntimeMetadata } }) | undefined> {
  const candidates = sortReusableRuntimeCandidates(metas);
  for (const candidate of candidates) {
    if (!runtimeMatchesConfiguredProjectScope(candidate)) {
      continue;
    }
    if (!runtimeHasReusableIdentity(candidate.browser.runtime)) {
      continue;
    }
    const port = resolvePort(candidate.browser.runtime);
    if (!port) {
      continue;
    }
    const host = candidate.browser.runtime.chromeHost ?? "127.0.0.1";
    const reachable = await probe({ host, port, attempts: 1, timeoutMs: 1000 });
    if (reachable.ok) {
      try {
        const targets = (await listTargets({
          host,
          port,
          browserWSEndpoint: candidate.browser.runtime.chromeBrowserWSEndpoint ?? undefined,
        })) as TargetInfoLite[];
        if (
          pickConnectableSupervisorRuntimeTarget(
            targets,
            candidate.browser.runtime,
            Boolean(candidate.browser.runtime.chromeBrowserWSEndpoint),
          )
        ) {
          return candidate;
        }
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export async function resolveSupervisorRuntimeContext(
  followupSession?: string,
): Promise<SupervisorRuntimeContext> {
  const hinted = followupSession?.trim();
  if (hinted) {
    const meta = await sessionStore.readSession(hinted);
    if (!meta) {
      throw new Error(`Browser runtime session ${hinted} was not found.`);
    }
    if (!hasReusableRuntime(meta)) {
      throw new Error(`Session ${hinted} does not have reusable browser runtime metadata.`);
    }
    if (!isOwnedSupervisorRuntime(meta)) {
      throw new Error(
        `Session ${hinted} is not an Oracle-owned hidden browser runtime. Refusing to attach the supervisor to a non-hidden browser session.`,
      );
    }
    if (!supervisorRuntimeIsReusableNow(meta)) {
      throw new Error(`Browser runtime session ${hinted} is not reusable yet.`);
    }
    const sessionId = await resolveMutableSupervisorRuntimeAnchorSessionId(meta);
    return {
      sessionId,
      runtime: await refreshOwnedSupervisorRuntime(meta),
    };
  }

  const metas = await sessionStore.listSessions();
  const latest = await pickReachableRuntimeCandidate(metas);
  if (!latest) {
    throw new Error(
      "No reachable Oracle-owned hidden browser runtime session was found. Run one Oracle browser turn first.",
    );
  }
  const sessionId = await resolveMutableSupervisorRuntimeAnchorSessionId(latest);
  return {
    sessionId,
    runtime: await refreshOwnedSupervisorRuntime(latest),
  };
}

async function closeClient(client: ChromeClient | null | undefined): Promise<void> {
  if (!client || typeof client.close !== "function") {
    return;
  }
  await client.close().catch(() => undefined);
}

export async function connectSupervisorRuntime(
  runtime: BrowserRuntimeMetadata,
): Promise<SupervisorRuntimeConnection> {
  const host = runtime.chromeHost ?? "127.0.0.1";
  const port = resolvePort(runtime);
  if (!port) {
    throw new Error("Browser runtime metadata is missing a reachable DevTools port.");
  }
  let browserWSEndpoint = runtime.chromeBrowserWSEndpoint ?? undefined;

  if (browserWSEndpoint && runtime.chromeTargetId) {
    let cachedConnection: Awaited<ReturnType<typeof connectToRemoteChromeTarget>> | null = null;
    try {
      cachedConnection = await connectToRemoteChromeTarget(host, port, noopLogger, {
        browserWSEndpoint,
        targetId: runtime.chromeTargetId,
        closeTargetOnDispose: false,
      });
    } catch (error) {
      if (browserWSEndpointLooksStale(error)) {
        browserWSEndpoint = undefined;
      }
    }
    if (cachedConnection) {
      try {
        const { client } = cachedConnection;
        const target = await readConnectedTargetInfo(
          client,
          {
            targetId: runtime.chromeTargetId,
            type: "page",
            url: runtime.tabUrl,
          },
          { requireVerification: true },
        );
        if (!connectedSupervisorTargetMatches(runtime, target)) {
          throw new Error("cached target no longer matches the reusable runtime");
        }
        if (client.Runtime?.enable) {
          await client.Runtime.enable();
        }
        return {
          client,
          close: cachedConnection.close,
          host,
          port,
          targetId: runtime.chromeTargetId,
        };
      } catch {
        await cachedConnection.close().catch(() => undefined);
      }
    }
  }

  let targets: TargetInfoLite[] | undefined;
  let targetListError: unknown = null;
  try {
    targets = (await listRemoteChromeTargets({
      host,
      port,
      browserWSEndpoint,
    })) as TargetInfoLite[];
  } catch (error) {
    targetListError = error;
    if (browserWSEndpoint) {
      browserWSEndpoint = undefined;
      try {
        targets = (await listRemoteChromeTargets({
          host,
          port,
        })) as TargetInfoLite[];
        targetListError = null;
      } catch (fallbackError) {
        targetListError = fallbackError;
      }
    }
  }
  if (targetListError) {
    const message =
      targetListError instanceof Error ? targetListError.message : String(targetListError);
    if (/No inspectable targets/i.test(message)) {
      throw new Error(
        "Unable to locate a reusable Oracle browser tab for the cached runtime. Run another Oracle browser turn or reopen the Oracle conversation before using supervisor thread controls.",
      );
    }
    throw targetListError;
  }
  if (!targets) {
    throw new Error("Unable to list reusable Oracle browser targets for the cached runtime.");
  }
  const strictTargetMatch = Boolean(browserWSEndpoint);
  const target = pickConnectableSupervisorRuntimeTarget(targets, runtime, strictTargetMatch);

  if (!target) {
    throw new Error(
      strictTargetMatch
        ? "Unable to locate the existing Oracle browser tab for the reusable runtime. Run another Oracle browser turn or reopen the Oracle conversation before using supervisor thread controls."
        : "Unable to safely locate a reusable Oracle browser tab for the cached runtime. Run another Oracle browser turn or reopen the Oracle conversation before using supervisor thread controls.",
    );
  }

  if (browserWSEndpoint && !target?.targetId) {
    throw new Error(
      "Unable to locate the existing Oracle browser tab for the reusable runtime. Run another Oracle browser turn or reopen the Oracle conversation before using supervisor thread controls.",
    );
  }

  const useBrowserSocketTarget = Boolean(browserWSEndpoint && target?.targetId);

  if (useBrowserSocketTarget) {
    const connection = await connectToRemoteChromeTarget(host, port, noopLogger, {
      browserWSEndpoint,
      targetId: target?.targetId,
      closeTargetOnDispose: false,
    });
    try {
      const { client } = connection;
      const connectedTarget = await readConnectedTargetInfo(client, target, {
        requireVerification: true,
      });
      if (!connectedTargetMatchesExpectedTarget(target, connectedTarget)) {
        throw new Error("connected target no longer matches the selected Oracle runtime target");
      }
      if (client.Runtime?.enable) {
        await client.Runtime.enable();
      }
      if (client.DOM?.enable) {
        await client.DOM.enable();
      }
      return {
        client,
        close: connection.close,
        host,
        port,
        targetId: connectedTarget.targetId ?? target?.targetId,
      };
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  const client = (await CDP({
    host,
    port,
    target: target?.targetId,
  })) as unknown as ChromeClient;
  try {
    const connectedTarget = await readConnectedTargetInfo(client, target, {
      requireVerification: true,
    });
    if (!connectedTargetMatchesExpectedTarget(target, connectedTarget)) {
      throw new Error("connected target no longer matches the selected Oracle runtime target");
    }
    if (client.Runtime?.enable) {
      await client.Runtime.enable();
    }
    if (client.DOM?.enable) {
      await client.DOM.enable();
    }
    return {
      client,
      close: async () => closeClient(client),
      host,
      port,
      targetId: connectedTarget.targetId ?? target?.targetId,
    };
  } catch (error) {
    await closeClient(client);
    throw error;
  }
}

export const __test__ = {
  isOwnedSupervisorRuntime,
  inferSupervisorRuntimeScopeUrl,
  pickConnectableSupervisorRuntimeTarget,
  processIsAlive,
  pickSupervisorRuntimeTarget,
  pickReachableRuntimeCandidate,
  pickReusableRuntimeCandidate,
  pickSafeSupervisorRecoveryTarget,
  refreshOwnedSupervisorRuntime,
  resolveMutableSupervisorRuntimeAnchorSessionId,
  runtimeControllerIsAlive,
  sortReusableRuntimeCandidates,
  supervisorRuntimePreference,
  supervisorRuntimeBindingPreference,
};
