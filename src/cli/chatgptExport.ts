import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { parseDuration } from "../browserMode.js";
import { formatBytes } from "../browser/utils.js";
import {
  captureApprovedChatGptConversationBackend,
  captureApprovedChatGptConversationBackendViaObu,
  conversationIdFromChatGptUrl,
} from "../browser/chatgptExport.js";
import { DEFAULT_REMOTE_CHROME_HOST, DEFAULT_REMOTE_CHROME_PORT } from "../browser/liveTabs.js";
import { extractStableConversationIdFromUrl } from "../browser/conversationUrl.js";
import { sessionStore, type SessionMetadata } from "../sessionStore.js";
import {
  browserIdFromWebSocketEndpoint,
  resolveRemoteChromeBrowserIdentity,
} from "../browser/profileState.js";

export interface ChatGptExportCliOptions {
  targetUrl?: string;
  out?: string;
  browserTab?: string;
  remoteChrome?: string;
  obuSessionId?: string;
  obuTabId?: string;
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
}

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
function sessionMatchesConversation(metadata: SessionMetadata, conversationId: string): boolean {
  return (
    metadata.browser?.harvest?.conversationId === conversationId ||
    metadata.browser?.runtime?.conversationId === conversationId ||
    storedConversationUrls(metadata).some(
      (url) => extractStableConversationIdFromUrl(url ?? "") === conversationId,
    )
  );
}

function storedRemoteChromeAffinities(
  metadata: SessionMetadata,
): ChatGptExportRemoteChromeAffinity[] {
  const runtimeBrowserWSEndpoint = metadata.browser?.runtime?.chromeBrowserWSEndpoint?.trim();
  const affinities = new Map<string, ChatGptExportRemoteChromeAffinity>();
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
    const browserWSEndpoint = runtimeBrowserWSEndpoint ?? configuredBrowserWSEndpoint;
    if (!browserWSEndpoint) {
      throw new Error("Stored remote Chrome browser identity is unavailable.");
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
    const affinity = { host, port, browserId, browserWSEndpoint };
    affinities.set(`${host.toLowerCase()}:${port}\t${browserId}`, affinity);
  }
  return [...affinities.values()];
}

/** Resolves a target conversation to its single recorded browser affinity. */
export function resolveChatGptExportRemoteChrome(
  targetUrl: string,
  sessions: SessionMetadata[],
): ChatGptExportRemoteChromeAffinity {
  const conversationId = conversationIdFromChatGptUrl(targetUrl);
  const affinities = new Map<string, ChatGptExportRemoteChromeAffinity>();
  const resolutionHint =
    process.env.ORACLE_WRAPPER_REMOTE_ONLY === "1"
      ? "Rerun the originating conversation through the agent wrapper to record its browser identity."
      : "Pass --remote-chrome explicitly.";
  let matchedSessionCount = 0;

  for (const metadata of sessions) {
    if (!sessionMatchesConversation(metadata, conversationId)) continue;
    matchedSessionCount += 1;
    const storedAffinities = storedRemoteChromeAffinities(metadata);
    if (storedAffinities.length === 0) {
      throw new Error(
        `Matched ChatGPT conversation ${conversationId} has no stored remote Chrome endpoint. ${resolutionHint}`,
      );
    }
    for (const affinity of storedAffinities) {
      affinities.set(
        `${affinity.host.toLowerCase()}:${affinity.port}\t${affinity.browserId}`,
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
  return affinities.values().next().value as ChatGptExportRemoteChromeAffinity;
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
  if (
    process.env.ORACLE_WRAPPER_REMOTE_ONLY === "1" &&
    (options.remoteChrome !== undefined || options.obuSessionId || options.obuTabId)
  ) {
    throw new Error(
      "The agent wrapper resolves exports from stored session affinity; remove explicit remote Chrome and OBU endpoint overrides.",
    );
  }
  const explicitRemoteChrome =
    options.remoteChrome === undefined ? undefined : parseRemoteChromeTarget(options.remoteChrome);
  const timeoutMs = options.timeout ? parseDuration(options.timeout, Number.NaN) : undefined;
  if (options.timeout && (!Number.isFinite(timeoutMs) || Number(timeoutMs) <= 0)) {
    throw new Error("--timeout must be a duration like 45s, 2m, or 500ms.");
  }
  if (options.obuSessionId && !options.obuTabId) {
    throw new Error("--obu-session-id requires --obu-tab-id.");
  }
  const remoteChromeAffinity = options.obuTabId
    ? { host: DEFAULT_REMOTE_CHROME_HOST, port: DEFAULT_REMOTE_CHROME_PORT }
    : explicitRemoteChrome
      ? {
          ...explicitRemoteChrome,
          ...(await resolveRemoteChromeBrowserIdentity(explicitRemoteChrome)),
        }
      : resolveChatGptExportRemoteChrome(targetUrl, await sessionStore.listSessions());
  const { host, port } = remoteChromeAffinity;
  const outDir = path.resolve(expandPath(options.out ?? defaultOutputDir(targetUrl)));
  const chunkSize = parsePositiveInteger(options.chunkSize, "--chunk-size");
  const result = options.obuTabId
    ? await captureApprovedChatGptConversationBackendViaObu({
        targetUrl,
        outDir,
        sessionId: options.obuSessionId,
        tabId: options.obuTabId,
        timeoutMs,
        chunkSize,
      })
    : await captureApprovedChatGptConversationBackend({
        targetUrl,
        outDir,
        tabRef: options.browserTab ?? targetUrl,
        host,
        port,
        browserId: "browserId" in remoteChromeAffinity ? remoteChromeAffinity.browserId : undefined,
        browserWSEndpoint:
          "browserWSEndpoint" in remoteChromeAffinity
            ? remoteChromeAffinity.browserWSEndpoint
            : undefined,
        timeoutMs,
        chunkSize,
        recoverArchived: options.recoverArchived,
        archiveAfterExport: options.archiveAfterExport,
      });

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
  console.log(
    chalk.dim(
      "Non-claim: Oracle did not read cookies, localStorage, browser profiles, or unrelated ChatGPT history; it captured only the approved backend conversation URL during page load.",
    ),
  );
}
