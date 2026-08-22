import { randomUUID } from "node:crypto";
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
import { browserIdFromWebSocketEndpoint } from "../browser/profileState.js";
import {
  CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV,
  hasChatGptRemoteAffinityFlags,
  parseRemoteChromeTarget,
  resolveChatGptRemoteAccountAffinity,
  type ChatGptRemoteAffinityCliOptions,
} from "./chatgptRemoteAffinity.js";
export { parseRemoteChromeTarget } from "./chatgptRemoteAffinity.js";

export interface ChatGptExportCliOptions extends ChatGptRemoteAffinityCliOptions {
  targetUrl?: string;
  sessionId?: string;
  out?: string;
  browserTab?: string;
  obuSessionId?: string;
  obuTabId?: string;
  timeout?: string | number | "auto";
  chunkSize?: string;
  knownArchived?: boolean;
  archiveAfterExport?: boolean;
  json?: boolean;
}

export interface ChatGptExportRemoteChromeAffinity {
  host: string;
  port: number;
  browserId: string;
  browserWSEndpoint: string;
  accountDigest: string;
}

export type ChatGptExportRemoteChromeTarget =
  | { host: string; port: number }
  | ChatGptExportRemoteChromeAffinity;

function storedConversationUrls(metadata: SessionMetadata): Array<string | null | undefined> {
  const optionsConfig = metadata.options?.browserConfig;
  const browserConfig = metadata.browser?.config;
  return [
    metadata.browser?.harvest?.url,
    metadata.browser?.runtime?.tabUrl,
    metadata.browser?.archive?.conversationUrl,
    metadata.options?.browserResumeConversationUrl,
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
): ChatGptExportRemoteChromeTarget[] {
  const runtimeBrowserWSEndpoint = metadata.browser?.runtime?.chromeBrowserWSEndpoint?.trim();
  const affinities = new Map<string, ChatGptExportRemoteChromeTarget>();
  for (const config of [metadata.options?.browserConfig, metadata.browser?.config]) {
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
    if (
      configuredAccountDigest &&
      runtimeAccountDigest &&
      configuredAccountDigest !== runtimeAccountDigest
    ) {
      throw new Error("Stored remote Chrome account identity is conflicting.");
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
    const affinity = { host, port, browserId, browserWSEndpoint, accountDigest };
    affinities.set(`${host.toLowerCase()}:${port}\t${browserId}\t${accountDigest}`, affinity);
  }
  return [...affinities.values()];
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
      : "Use --session-id for the originating Oracle session, omit endpoint overrides for an unambiguous stored session, or use the account-bound wrapper.";
  let matchedSessionCount = 0;

  for (const metadata of sessions) {
    if (!sessionMatchesConversation(metadata, conversationId)) continue;
    matchedSessionCount += 1;
    const storedAffinities = storedRemoteChromeAffinities(metadata);
    if (storedAffinities.length === 0) {
      throw new Error(
        `The matching ChatGPT conversation has no stored remote Chrome endpoint. ${resolutionHint}`,
      );
    }
    for (const affinity of storedAffinities) {
      const browserId = "browserId" in affinity ? affinity.browserId : "";
      const accountDigest = "accountDigest" in affinity ? affinity.accountDigest : "";
      affinities.set(
        `${affinity.host.toLowerCase()}:${affinity.port}\t${browserId}\t${accountDigest}`,
        affinity,
      );
    }
  }

  if (matchedSessionCount === 0) {
    throw new Error(
      `No stored browser session matches the requested ChatGPT conversation. ${resolutionHint}`,
    );
  }
  if (affinities.size !== 1) {
    throw new Error(
      `The requested ChatGPT conversation has conflicting stored remote Chrome browser affinities. ${resolutionHint}`,
    );
  }
  return affinities.values().next().value as ChatGptExportRemoteChromeTarget;
}

/** Resolves one known Oracle session to its recorded browser affinity. */
export function resolveChatGptExportRemoteChromeForSession(
  targetUrl: string,
  _sessionId: string,
  metadata: SessionMetadata | null,
): ChatGptExportRemoteChromeTarget {
  const conversationId = conversationIdFromChatGptUrl(targetUrl);
  if (!metadata) {
    throw new Error("The requested stored Oracle session was not found.");
  }
  if (!sessionMatchesConversation(metadata, conversationId)) {
    throw new Error("The requested stored Oracle session does not match the ChatGPT conversation.");
  }
  return resolveChatGptExportRemoteChrome(targetUrl, [metadata]);
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

function defaultOutputDir(): string {
  return path.join(os.homedir(), "Documents", "chatgpt-conversation-exports", randomUUID());
}

function parsePositiveInteger(raw: string | undefined, label: string): number | undefined {
  if (raw == null) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function assertCompatibleChatGptExportAffinitySources(options: ChatGptExportCliOptions): void {
  const hasSessionAffinity = options.sessionId !== undefined;
  const hasObuAffinity = options.obuSessionId !== undefined || options.obuTabId !== undefined;
  const hasExplicitRemoteAffinity =
    options.remoteChrome !== undefined ||
    options.remoteChromeBrowserId !== undefined ||
    options.remoteChromeBrowserWs !== undefined ||
    options.remoteChromeAccountDigest !== undefined ||
    options.expectedEmail !== undefined;

  if (hasObuAffinity && (hasSessionAffinity || hasExplicitRemoteAffinity)) {
    throw new Error(
      "OBU affinity (--obu-session-id/--obu-tab-id) cannot be combined with --session-id, --remote-chrome, or explicit remote browser/account affinity flags.",
    );
  }
  if (hasSessionAffinity && hasExplicitRemoteAffinity) {
    throw new Error(
      "--session-id cannot be combined with --remote-chrome or explicit remote browser/account affinity flags.",
    );
  }
  if (hasObuAffinity && options.browserTab !== undefined) {
    throw new Error(
      "--browser-tab cannot be combined with OBU affinity; use --obu-tab-id to select the approved OBU tab.",
    );
  }
}

export async function handleChatGptExportCommand(options: ChatGptExportCliOptions): Promise<void> {
  const targetUrl = options.targetUrl?.trim();
  if (!targetUrl) {
    throw new Error("--target-url is required.");
  }
  conversationIdFromChatGptUrl(targetUrl);
  const accountBoundWrapper = process.env[CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV] === "1";
  if (accountBoundWrapper && (options.sessionId || options.obuSessionId || options.obuTabId)) {
    throw new Error(
      "The account-bound wrapper cannot be combined with stored sessions or OBU tabs.",
    );
  }
  if (!accountBoundWrapper) {
    assertCompatibleChatGptExportAffinitySources(options);
  }
  if (options.obuTabId && options.archiveAfterExport) {
    throw new Error("--archive-after-export is not supported for OBU exports.");
  }
  if (!accountBoundWrapper && options.archiveAfterExport) {
    throw new Error("--archive-after-export requires the account-bound wrapper.");
  }
  if (accountBoundWrapper && options.knownArchived === true && options.archiveAfterExport) {
    throw new Error("--archive-after-export cannot be used for a conversation already archived.");
  }
  if (accountBoundWrapper && options.knownArchived === undefined) {
    throw new Error("The account-bound wrapper requires the inventory's known archive state.");
  }
  if (!accountBoundWrapper && options.knownArchived !== undefined) {
    throw new Error(
      `Direct archive-state affinity requires ${CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV}=1.`,
    );
  }
  if (!accountBoundWrapper && hasChatGptRemoteAffinityFlags(options)) {
    throw new Error(
      `Direct ChatGPT account affinity flags require ${CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV}=1.`,
    );
  }
  if (
    !accountBoundWrapper &&
    (options.remoteChrome !== undefined || options.obuSessionId || options.obuTabId)
  ) {
    throw new Error(
      "Direct --remote-chrome and OBU ChatGPT exports do not have authoritative approved account affinity. Use --session-id, omit endpoint overrides for stored session affinity, or use the account-bound wrapper.",
    );
  }
  const wrapperAffinity = accountBoundWrapper
    ? resolveChatGptRemoteAccountAffinity(options)
    : undefined;
  const explicitRemoteChrome =
    accountBoundWrapper || options.remoteChrome === undefined
      ? undefined
      : parseRemoteChromeTarget(options.remoteChrome);
  const timeoutMs =
    options.timeout === undefined || options.timeout === "auto"
      ? undefined
      : typeof options.timeout === "number"
        ? options.timeout * 1000
        : parseDuration(options.timeout, Number.NaN);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("--timeout must be a duration like 45s, 2m, or 500ms.");
  }
  if (options.obuSessionId && !options.obuTabId) {
    throw new Error("--obu-session-id requires --obu-tab-id.");
  }
  const remoteChromeAffinity: ChatGptExportRemoteChromeTarget = wrapperAffinity
    ? wrapperAffinity
    : options.obuTabId
      ? { host: DEFAULT_REMOTE_CHROME_HOST, port: DEFAULT_REMOTE_CHROME_PORT }
      : explicitRemoteChrome
        ? explicitRemoteChrome
        : options.sessionId
          ? resolveChatGptExportRemoteChromeForSession(
              targetUrl,
              options.sessionId,
              await sessionStore.readSession(options.sessionId),
            )
          : resolveChatGptExportRemoteChrome(targetUrl, await sessionStore.listSessions());
  const { host, port } = remoteChromeAffinity;
  const boundRemoteChromeAffinity =
    "browserId" in remoteChromeAffinity
      ? (remoteChromeAffinity as ChatGptExportRemoteChromeAffinity)
      : undefined;
  const outDir = path.resolve(expandPath(options.out ?? defaultOutputDir()));
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
        browserId: boundRemoteChromeAffinity?.browserId,
        browserWSEndpoint: boundRemoteChromeAffinity?.browserWSEndpoint,
        accountDigest: boundRemoteChromeAffinity?.accountDigest,
        expectedEmail: wrapperAffinity?.expectedEmail,
        timeoutMs,
        chunkSize,
        knownArchived: accountBoundWrapper ? options.knownArchived : undefined,
        archiveAfterExport: accountBoundWrapper ? options.archiveAfterExport : undefined,
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
      result.archiveRecovery.status === "read-only"
        ? "Non-claim: Oracle did not read cookie values, localStorage, browser profiles, or unrelated ChatGPT history; it fetched only the exact approved backend conversation URL through a verified authenticated page context and did not change archive state."
        : result.postExportArchive
          ? "Non-claim: Oracle did not read cookie values, localStorage, browser profiles, or unrelated ChatGPT history; it captured only the exact approved backend conversation URL during page load, then performed the explicitly requested post-export archive."
          : "Non-claim: Oracle did not read cookie values, localStorage, browser profiles, or unrelated ChatGPT history; it captured only the exact approved backend conversation URL during page load and did not change archive state.",
    ),
  );
}
