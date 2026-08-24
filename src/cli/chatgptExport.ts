import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { parseDuration } from "../browserMode.js";
import { formatBytes } from "../browser/utils.js";
import {
  captureApprovedChatGptConversationBackend,
  captureApprovedChatGptConversationBackendViaObu,
  conversationIdFromChatGptUrl,
  type ChatGptExportTurnAffinity,
} from "../browser/chatgptExport.js";
import {
  chatGptConversationScopeFromUrl,
  type ChatGptConversationScope,
} from "../browser/conversationUrl.js";
import { extractStableConversationIdFromUrl } from "../browser/conversationUrl.js";
import { sessionStore, type SessionMetadata } from "../sessionStore.js";
import { browserIdFromWebSocketEndpoint } from "../browser/profileState.js";
import {
  hasStoredOpenBrowserUseAffinity,
  resolveStoredOpenBrowserUseAffinity,
  type StoredOpenBrowserUseAffinity,
} from "../browser/openBrowserUse.js";
import { asOracleUserError, sanitizeErrorForPersistence } from "../oracle/errors.js";

export interface ChatGptExportCliOptions {
  targetUrl?: string;
  sessionId?: string;
  out?: string;
  browserTab?: string;
  remoteChrome?: string;
  timeout?: string;
  chunkSize?: string;
  recoverArchived?: boolean;
  archiveAfterExport?: boolean;
  json?: boolean;
}

export interface ChatGptExportRemoteChromeAffinity {
  host: string;
  port: number;
  browserId: string;
  browserWSEndpoint: string;
  accountDigest: string;
  workspaceDigest?: string;
}

export type ChatGptExportRemoteChromeTarget =
  | { host: string; port: number }
  | ChatGptExportRemoteChromeAffinity;

export type ChatGptExportBrowserTarget =
  | {
      transport: "cdp";
      affinity: ChatGptExportRemoteChromeTarget;
      turnAffinity?: ChatGptExportTurnAffinity;
    }
  | {
      transport: "obu";
      affinity: StoredOpenBrowserUseAffinity;
      turnAffinity: ChatGptExportTurnAffinity;
    };
function storedConversationUrls(metadata: SessionMetadata): Array<string | null | undefined> {
  const optionsConfig = metadata.options.browserConfig;
  const browserConfig = metadata.browser?.config;
  return [
    metadata.browser?.harvest?.url,
    metadata.browser?.runtime?.tabUrl,
    metadata.browser?.archive?.conversationUrl,
    metadata.options.browserResumeConversationUrl,
    optionsConfig?.resumeConversationUrl,
    optionsConfig?.chatgptUrl,
    optionsConfig?.url,
    browserConfig?.resumeConversationUrl,
    browserConfig?.chatgptUrl,
    browserConfig?.url,
  ];
}
function storedConversationScopes(metadata: SessionMetadata): ChatGptConversationScope[] {
  const scopes: ChatGptConversationScope[] = [];
  for (const raw of storedConversationUrls(metadata)) {
    const candidate = raw?.trim();
    if (!candidate) continue;
    const scope = chatGptConversationScopeFromUrl(candidate);
    if (scope) {
      scopes.push(scope);
      continue;
    }
    if (extractStableConversationIdFromUrl(candidate)) {
      throw new Error("Stored ChatGPT conversation URL is invalid.");
    }
  }
  return scopes;
}

function sessionMatchesConversation(metadata: SessionMetadata, targetUrl: string): boolean {
  const targetScope = chatGptConversationScopeFromUrl(targetUrl);
  if (!targetScope) return false;
  const scopes = storedConversationScopes(metadata);
  if (scopes.length > 0) {
    const matchingScopes = scopes.filter(
      (scope) => scope.conversationId === targetScope.conversationId,
    );
    if (
      targetScope.projectKey !== null &&
      !matchingScopes.some((scope) => scope.projectKey === targetScope.projectKey)
    ) {
      return false;
    }
    const hasTargetEvidence =
      matchingScopes.length > 0 ||
      metadata.browser?.harvest?.conversationId === targetScope.conversationId ||
      metadata.browser?.runtime?.conversationId === targetScope.conversationId;
    if (!hasTargetEvidence) return false;
    return true;
  }
  if (targetScope.projectKey !== null) return false;
  return (
    metadata.browser?.harvest?.conversationId === targetScope.conversationId ||
    metadata.browser?.runtime?.conversationId === targetScope.conversationId
  );
}

function assertConversationScopeAffinity(metadata: SessionMetadata, targetUrl: string): void {
  const targetScope = chatGptConversationScopeFromUrl(targetUrl);
  if (!targetScope) throw new Error("ChatGPT conversation target is invalid.");
  const scopes = storedConversationScopes(metadata);
  if (
    targetScope.projectKey !== null &&
    !scopes.some(
      (scope) =>
        scope.conversationId === targetScope.conversationId &&
        scope.projectKey === targetScope.projectKey,
    )
  ) {
    throw new Error("Stored ChatGPT project conversation affinity is unavailable.");
  }
  const distinctScopes = new Set(
    scopes.map((scope) => `${scope.conversationId}\t${scope.projectKey ?? ""}`),
  );
  const recordedIds = [
    metadata.browser?.harvest?.conversationId,
    metadata.browser?.runtime?.conversationId,
  ]
    .filter((id): id is string => Boolean(id?.trim()))
    .map((id) => id.trim());
  if (
    distinctScopes.size > 1 ||
    scopes.some(
      (scope) =>
        scope.conversationId !== targetScope.conversationId ||
        scope.projectKey !== targetScope.projectKey,
    ) ||
    recordedIds.some((id) => id !== targetScope.conversationId)
  ) {
    throw new Error("Stored ChatGPT conversation affinity is conflicting.");
  }
}

function storedRemoteChromeAffinities(
  metadata: SessionMetadata,
): ChatGptExportRemoteChromeTarget[] {
  const runtimeBrowserWSEndpoint = metadata.browser?.runtime?.chromeBrowserWSEndpoint?.trim();
  const affinities = new Map<string, ChatGptExportRemoteChromeTarget>();
  for (const config of [metadata.options.browserConfig, metadata.browser?.config]) {
    const endpoint = config?.remoteChrome;
    if (!endpoint) continue;
    const host = typeof endpoint.host === "string" ? endpoint.host.trim() : "";
    const port = endpoint.port;
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error("Stored remote Chrome endpoint is invalid.");
    }
    const configuredBrowserId = config?.remoteChromeBrowserId?.trim();
    const configuredBrowserWSEndpoint = config?.remoteChromeBrowserWSEndpoint?.trim();
    const configuredAccountDigest = config?.remoteChromeAccountDigest?.trim();
    const runtimeAccountDigest = metadata.browser?.runtime?.chatGptAccountDigest?.trim();
    const accountDigest = runtimeAccountDigest ?? configuredAccountDigest;
    const configuredWorkspaceDigest = config?.chatGptWorkspaceDigest?.trim();
    const runtimeWorkspaceDigest = metadata.browser?.runtime?.chatGptWorkspaceDigest?.trim();
    const workspaceDigest = runtimeWorkspaceDigest ?? configuredWorkspaceDigest;
    if (
      configuredAccountDigest &&
      runtimeAccountDigest &&
      configuredAccountDigest !== runtimeAccountDigest
    ) {
      throw new Error("Stored remote Chrome account identity is conflicting.");
    }
    if (
      configuredWorkspaceDigest &&
      runtimeWorkspaceDigest &&
      configuredWorkspaceDigest !== runtimeWorkspaceDigest
    ) {
      throw new Error("Stored remote Chrome workspace identity is conflicting.");
    }
    const browserWSEndpoint = runtimeBrowserWSEndpoint ?? configuredBrowserWSEndpoint;
    if (!browserWSEndpoint || !accountDigest) {
      throw new Error("Stored remote Chrome browser and account identity is unavailable.");
    }
    const browserId = browserIdFromWebSocketEndpoint(browserWSEndpoint);
    if (configuredBrowserId && configuredBrowserId !== browserId) {
      throw new Error("Stored remote Chrome browser identity is conflicting.");
    }
    if (
      configuredBrowserWSEndpoint &&
      browserIdFromWebSocketEndpoint(configuredBrowserWSEndpoint) !== browserId
    ) {
      throw new Error("Stored remote Chrome browser identity is conflicting.");
    }
    if (!/^[a-f0-9]{64}$/.test(accountDigest)) {
      throw new Error("Stored remote Chrome account identity is invalid.");
    }
    if (workspaceDigest && !/^[a-f0-9]{64}$/.test(workspaceDigest)) {
      throw new Error("Stored remote Chrome workspace identity is invalid.");
    }
    const affinity = {
      host,
      port,
      browserId,
      browserWSEndpoint,
      accountDigest,
      ...(workspaceDigest ? { workspaceDigest } : {}),
    };
    affinities.set(
      `${host.toLowerCase()}:${port}\t${browserId}\t${accountDigest}\t${workspaceDigest ?? ""}`,
      affinity,
    );
  }
  return [...affinities.values()];
}
function storedOpenBrowserUseAffinity(
  metadata: SessionMetadata,
  targetUrl: string,
): StoredOpenBrowserUseAffinity | null {
  const runtime = metadata.browser?.runtime;
  const configs = [metadata.options.browserConfig, metadata.browser?.config];
  if (!hasStoredOpenBrowserUseAffinity({ runtime, configs })) return null;
  return resolveStoredOpenBrowserUseAffinity({
    runtime,
    configs,
    conversationUrl: targetUrl,
    conversationUrls: storedConversationUrls(metadata),
    conversationIds: [metadata.browser?.harvest?.conversationId],
  });
}

function storedExportTurnAffinity(metadata: SessionMetadata): ChatGptExportTurnAffinity | null {
  const runtime = metadata.browser?.runtime;
  const promptMessageId = runtime?.promptMessageId?.trim();
  const assistantMessageId = runtime?.assistantMessageId?.trim();
  return promptMessageId && assistantMessageId ? { promptMessageId, assistantMessageId } : null;
}

function resolveStoredChatGptExportTarget(
  targetUrl: string,
  sessions: SessionMetadata[],
): ChatGptExportBrowserTarget {
  const conversationId = conversationIdFromChatGptUrl(targetUrl);
  const matches = sessions.filter((metadata) => sessionMatchesConversation(metadata, targetUrl));
  if (matches.length === 0) {
    throw new Error(`No stored browser session matches ChatGPT conversation ${conversationId}.`);
  }
  for (const metadata of matches) assertConversationScopeAffinity(metadata, targetUrl);
  const targets = new Map<string, ChatGptExportBrowserTarget>();
  for (const metadata of matches) {
    const turnAffinity = storedExportTurnAffinity(metadata);
    const obuAffinity = storedOpenBrowserUseAffinity(metadata, targetUrl);
    if (obuAffinity) {
      if (!turnAffinity) {
        throw new Error(
          `Stored Oracle session ${metadata.id} has no exact prompt/assistant branch affinity for export.`,
        );
      }
      targets.set(
        `obu\t${obuAffinity.sessionId}\t${obuAffinity.tabId}\t${obuAffinity.accountDigest}\t${obuAffinity.workspaceDigest}\t${turnAffinity.promptMessageId}\t${turnAffinity.assistantMessageId}`,
        { transport: "obu", affinity: obuAffinity, turnAffinity },
      );
      continue;
    }
    for (const affinity of storedRemoteChromeAffinities(metadata)) {
      const browserId = "browserId" in affinity ? affinity.browserId : "";
      const accountDigest = "accountDigest" in affinity ? affinity.accountDigest : "";
      const workspaceDigest = "workspaceDigest" in affinity ? affinity.workspaceDigest : "";
      const branchKey = turnAffinity
        ? `${turnAffinity.promptMessageId}\t${turnAffinity.assistantMessageId}`
        : "";
      targets.set(
        `cdp\t${affinity.host}:${affinity.port}\t${browserId}\t${accountDigest}\t${workspaceDigest}\t${branchKey}`,
        { transport: "cdp", affinity, ...(turnAffinity ? { turnAffinity } : {}) },
      );
    }
  }
  if (targets.size !== 1) {
    throw new Error(
      `Matched ChatGPT conversation ${conversationId} has conflicting stored browser affinities.`,
    );
  }
  return targets.values().next().value as ChatGptExportBrowserTarget;
}

export function resolveChatGptExportBrowserTargetForSession(
  targetUrl: string,
  sessionId: string,
  metadata: SessionMetadata | null,
): ChatGptExportBrowserTarget {
  const conversationId = conversationIdFromChatGptUrl(targetUrl);
  if (!metadata) throw new Error(`Stored Oracle session ${sessionId} was not found.`);
  if (!sessionMatchesConversation(metadata, targetUrl)) {
    throw new Error(
      `Stored Oracle session ${sessionId} does not match ChatGPT conversation ${conversationId}.`,
    );
  }
  return resolveStoredChatGptExportTarget(targetUrl, [metadata]);
}

export function resolveChatGptExportBrowserTarget(
  targetUrl: string,
  sessions: SessionMetadata[],
): ChatGptExportBrowserTarget {
  return resolveStoredChatGptExportTarget(targetUrl, sessions);
}

/** Resolves a target conversation to its single recorded browser affinity. */
export function resolveChatGptExportRemoteChrome(
  targetUrl: string,
  sessions: SessionMetadata[],
): ChatGptExportRemoteChromeTarget {
  const conversationId = conversationIdFromChatGptUrl(targetUrl);
  const affinities = new Map<string, ChatGptExportRemoteChromeTarget>();
  const resolutionHint =
    process.env.ORACLE_WRAPPER_REMOTE_ONLY === "1"
      ? "Rerun the originating conversation through the agent wrapper to record its browser identity."
      : "Pass --remote-chrome explicitly.";
  let matchedSessionCount = 0;

  for (const metadata of sessions) {
    if (!sessionMatchesConversation(metadata, targetUrl)) continue;
    assertConversationScopeAffinity(metadata, targetUrl);
    matchedSessionCount += 1;
    const storedAffinities = storedRemoteChromeAffinities(metadata);
    if (storedAffinities.length === 0) {
      throw new Error(
        `Matched ChatGPT conversation ${conversationId} has no stored remote Chrome endpoint. ${resolutionHint}`,
      );
    }
    for (const affinity of storedAffinities) {
      const browserId = "browserId" in affinity ? affinity.browserId : "";
      const accountDigest = "accountDigest" in affinity ? affinity.accountDigest : "";
      const workspaceDigest = "workspaceDigest" in affinity ? affinity.workspaceDigest : "";
      affinities.set(
        `${affinity.host.toLowerCase()}:${affinity.port}\t${browserId}\t${accountDigest}\t${workspaceDigest}`,
        affinity,
      );
    }
  }

  if (matchedSessionCount === 0) {
    throw new Error(
      `No stored browser session matches ChatGPT conversation ${conversationId}. ${resolutionHint}`,
    );
  }
  if (affinities.size !== 1) {
    throw new Error(
      `Matched ChatGPT conversation ${conversationId} has conflicting stored remote Chrome browser affinities. ${resolutionHint}`,
    );
  }
  return affinities.values().next().value as ChatGptExportRemoteChromeTarget;
}

/** Resolves one known Oracle session to its recorded browser affinity. */
export function resolveChatGptExportRemoteChromeForSession(
  targetUrl: string,
  sessionId: string,
  metadata: SessionMetadata | null,
): ChatGptExportRemoteChromeTarget {
  const conversationId = conversationIdFromChatGptUrl(targetUrl);
  if (!metadata) {
    throw new Error(`Stored Oracle session ${sessionId} was not found.`);
  }
  if (!sessionMatchesConversation(metadata, targetUrl)) {
    throw new Error(
      `Stored Oracle session ${sessionId} does not match ChatGPT conversation ${conversationId}.`,
    );
  }
  return resolveChatGptExportRemoteChrome(targetUrl, [metadata]);
}

export function parseRemoteChromeTarget(raw: string): { host: string; port: number } {
  const target = raw.trim();
  if (!target) {
    throw new Error("Invalid remote-chrome value: empty. Expected host:port.");
  }
  const ipv6Match = target.match(/^\[(.+)]:(\d+)$/);
  let host: string | undefined;
  let portSegment: string | undefined;
  if (ipv6Match) {
    host = ipv6Match[1]?.trim();
    portSegment = ipv6Match[2]?.trim();
  } else {
    const lastColon = target.lastIndexOf(":");
    if (lastColon === -1) {
      throw new Error(
        `Invalid remote-chrome format: ${target}. Expected host:port (IPv6 must use [host]:port notation).`,
      );
    }
    host = target.slice(0, lastColon).trim();
    portSegment = target.slice(lastColon + 1).trim();
    if (host.includes(":")) {
      throw new Error(
        `Invalid remote-chrome format: ${target}. Wrap IPv6 addresses in brackets, e.g. --remote-chrome "[2001:db8::1]:9222".`,
      );
    }
  }
  if (!/^\d+$/.test(portSegment ?? "")) {
    throw new Error(`Invalid remote-chrome value: ${target}. Expected host:port.`);
  }
  const port = Number(portSegment);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid remote-chrome value: ${target}. Expected host:port.`);
  }
  return { host, port };
}

function expandPath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function defaultOutputDir(targetUrl: string): string {
  const conversationId = conversationIdFromChatGptUrl(targetUrl);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return path.join(
    os.homedir(),
    "Documents",
    "chatgpt-conversation-exports",
    `oracle-chatgpt-conversation-${conversationId}-${stamp}`,
  );
}

function parsePositiveInteger(raw: string | undefined, label: string): number | undefined {
  if (raw == null) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export async function handleChatGptExportCommand(options: ChatGptExportCliOptions): Promise<void> {
  const targetUrl = options.targetUrl?.trim();
  if (!targetUrl) {
    throw new Error("--target-url is required.");
  }
  conversationIdFromChatGptUrl(targetUrl);
  if (process.env.ORACLE_WRAPPER_REMOTE_ONLY === "1" && options.remoteChrome !== undefined) {
    throw new Error(
      "The agent wrapper resolves exports from stored session affinity; remove explicit remote Chrome endpoint overrides.",
    );
  }
  const explicitRemoteChrome =
    options.remoteChrome === undefined ? undefined : parseRemoteChromeTarget(options.remoteChrome);
  const timeoutMs = options.timeout ? parseDuration(options.timeout, Number.NaN) : undefined;
  if (options.timeout && (!Number.isFinite(timeoutMs) || Number(timeoutMs) <= 0)) {
    throw new Error("--timeout must be a duration like 45s, 2m, or 500ms.");
  }
  const namedMetadata = options.sessionId
    ? await sessionStore.readSession(options.sessionId)
    : null;
  let browserTarget: ChatGptExportBrowserTarget;
  if (explicitRemoteChrome && options.sessionId) {
    const storedTarget = resolveChatGptExportBrowserTargetForSession(
      targetUrl,
      options.sessionId,
      namedMetadata,
    );
    if (storedTarget.transport === "obu") {
      throw new Error(
        "--remote-chrome cannot override a named main-Chrome session; use its stored OBU affinity.",
      );
    }
    if (
      storedTarget.affinity.host.toLowerCase() !== explicitRemoteChrome.host.toLowerCase() ||
      storedTarget.affinity.port !== explicitRemoteChrome.port
    ) {
      throw new Error(
        "--remote-chrome does not match the named session's stored browser endpoint; refusing an affinity bypass.",
      );
    }
    browserTarget = storedTarget;
  } else if (explicitRemoteChrome) {
    browserTarget = { transport: "cdp", affinity: explicitRemoteChrome };
  } else if (options.sessionId) {
    browserTarget = resolveChatGptExportBrowserTargetForSession(
      targetUrl,
      options.sessionId,
      namedMetadata,
    );
  } else {
    browserTarget = resolveChatGptExportBrowserTarget(targetUrl, await sessionStore.listSessions());
  }
  if (browserTarget.transport === "obu" && options.browserTab?.trim()) {
    throw new Error(
      "Main-Chrome exports use their stored task-tab affinity; remove --browser-tab.",
    );
  }
  if (browserTarget.transport === "obu" && options.recoverArchived === false) {
    throw new Error(
      "--no-recover-archived is unavailable for main-Chrome exports; remove it or use the legacy CDP export path.",
    );
  }
  const outDir = path.resolve(expandPath(options.out ?? defaultOutputDir(targetUrl)));
  const chunkSize = parsePositiveInteger(options.chunkSize, "--chunk-size");
  const remoteChromeIdentity =
    browserTarget.transport === "cdp" && "browserId" in browserTarget.affinity
      ? (browserTarget.affinity as ChatGptExportRemoteChromeAffinity)
      : undefined;
  const result = await (async () => {
    try {
      return browserTarget.transport === "obu"
        ? await captureApprovedChatGptConversationBackendViaObu({
            targetUrl,
            outDir,
            oracleSessionId: options.sessionId,
            obuSessionId: browserTarget.affinity.sessionId,
            obuTabId: browserTarget.affinity.tabId,
            email: browserTarget.affinity.email,
            workspaceName: browserTarget.affinity.workspaceName,
            accountDigest: browserTarget.affinity.accountDigest,
            workspaceDigest: browserTarget.affinity.workspaceDigest,
            turnAffinity: browserTarget.turnAffinity,
            timeoutMs,
            chunkSize,
            archiveAfterExport: options.archiveAfterExport,
          })
        : await captureApprovedChatGptConversationBackend({
            targetUrl,
            outDir,
            tabRef: options.browserTab ?? targetUrl,
            host: browserTarget.affinity.host,
            port: browserTarget.affinity.port,
            browserId: remoteChromeIdentity?.browserId,
            browserWSEndpoint: remoteChromeIdentity?.browserWSEndpoint,
            accountDigest: remoteChromeIdentity?.accountDigest,
            workspaceDigest: remoteChromeIdentity?.workspaceDigest,
            timeoutMs,
            chunkSize,
            turnAffinity: browserTarget.turnAffinity,
            recoverArchived: options.recoverArchived,
            archiveAfterExport: options.archiveAfterExport,
          });
    } catch (error) {
      if (options.sessionId) {
        const metadata = await sessionStore.readSession(options.sessionId);
        const userError = asOracleUserError(error);
        const operationError = userError
          ? {
              category: userError.category,
              ...sanitizeErrorForPersistence(
                userError.message,
                userError.details,
                "chatgpt-export",
              ),
            }
          : {
              category: "browser-automation",
              ...sanitizeErrorForPersistence(
                "ChatGPT export failed. Rerun the export to see the current error.",
                undefined,
                "chatgpt-export",
              ),
            };
        const browser = {
          ...(metadata?.browser ?? {}),
          operationErrors: {
            ...(metadata?.browser?.operationErrors ?? {}),
            "chatgpt-export": operationError,
          },
        };
        await sessionStore.updateSession(options.sessionId, { browser }).catch(() => undefined);
      }
      throw error;
    }
  })();
  if (options.sessionId) {
    const metadata = await sessionStore.readSession(options.sessionId);
    if (metadata?.browser?.operationErrors?.["chatgpt-export"]) {
      const operationErrors = { ...metadata.browser.operationErrors };
      delete operationErrors["chatgpt-export"];
      const browser = {
        ...metadata.browser,
        operationErrors: Object.keys(operationErrors).length > 0 ? operationErrors : undefined,
      };
      await sessionStore.updateSession(options.sessionId, { browser }).catch(() => undefined);
    }
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.bold("ChatGPT conversation export complete"));
  console.log(`Target: ${result.targetUrl}`);
  console.log(`Conversation: ${result.conversationId}`);
  if (result.title) {
    console.log(`Title: ${result.title}`);
  }
  console.log(`Output: ${result.outputDir}`);
  console.log(
    `Raw backend: ${result.rawBackendPath} (${formatBytes(result.rawBackendSizeBytes)}, sha256 ${result.rawBackendSha256})`,
  );
  console.log(`Payload: ${result.payloadPath}`);
  console.log(`Markdown: ${result.markdownPath}`);
  console.log(`Manifest: ${result.manifestPath}`);
  console.log(`Checksums: ${result.sha256SumsPath}`);
  console.log(
    `Counts: ${result.turnCount} turns, ${result.mappingCount} mapping nodes, ${result.currentPathNodeCount} current-path nodes`,
  );
  for (const warning of result.warnings ?? []) {
    console.log(chalk.yellow(`Warning (${warning.code}): ${warning.message}`));
    if (warning.details) {
      console.log(chalk.dim(`Warning details: ${JSON.stringify(warning.details)}`));
    }
  }
  console.log(
    chalk.dim(
      "Non-claim: Oracle did not read cookies, localStorage, browser profiles, or unrelated ChatGPT history; it captured only the approved backend conversation URL during page load.",
    ),
  );
}
