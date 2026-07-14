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

function parseRemoteChromeTarget(raw: string | undefined): { host: string; port: number } {
  const target = raw?.trim();
  if (!target) {
    return { host: DEFAULT_REMOTE_CHROME_HOST, port: DEFAULT_REMOTE_CHROME_PORT };
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
  const port = Number.parseInt(portSegment ?? "", 10);
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65_535) {
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
  const { host, port } = parseRemoteChromeTarget(options.remoteChrome);
  const timeoutMs = options.timeout ? parseDuration(options.timeout, Number.NaN) : undefined;
  if (options.timeout && (!Number.isFinite(timeoutMs) || Number(timeoutMs) <= 0)) {
    throw new Error("--timeout must be a duration like 45s, 2m, or 500ms.");
  }
  if (options.obuSessionId && !options.obuTabId) {
    throw new Error("--obu-session-id requires --obu-tab-id.");
  }
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
