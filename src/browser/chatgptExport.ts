import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChromeClient } from "./types.js";
import {
  connectToExistingChatGptTab,
  DEFAULT_REMOTE_CHROME_HOST,
  DEFAULT_REMOTE_CHROME_PORT,
} from "./liveTabs.js";
import { delay } from "./utils.js";

const execFileAsync = promisify(execFile);

type JsonRecord = Record<string, unknown>;

interface BackendMessage {
  id?: string;
  author?: {
    role?: string;
    name?: string;
  };
  content?: JsonRecord;
  metadata?: JsonRecord;
  create_time?: number | string | null;
  update_time?: number | string | null;
  status?: string;
  channel?: string | null;
  recipient?: string | null;
}

interface BackendNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: BackendMessage | null;
}

interface BackendConversation {
  title?: string;
  conversation_id?: string;
  current_node?: string;
  mapping?: Record<string, BackendNode>;
  [key: string]: unknown;
}

export interface ChatGptConversationExportOptions {
  targetUrl: string;
  outDir: string;
  tabRef?: string;
  host?: string;
  port?: number;
  timeoutMs?: number;
  chunkSize?: number;
}

export interface ChatGptConversationExportObuOptions {
  targetUrl: string;
  outDir: string;
  sessionId?: string;
  tabId: string;
  timeoutMs?: number;
  chunkSize?: number;
}

export interface ChatGptConversationExportResult {
  ok: true;
  outputDir: string;
  targetUrl: string;
  targetApiUrl: string;
  conversationId: string;
  title?: string;
  targetId: string;
  tabUrl: string;
  rawBackendPath: string;
  rawBackendSha256: string;
  rawBackendSizeBytes: number;
  payloadPath: string;
  markdownPath: string;
  manifestPath: string;
  captureInfoPath: string;
  sha256SumsPath: string;
  mappingCount: number;
  currentPathNodeCount: number;
  turnCount: number;
  stats: Record<string, unknown>;
}

interface CaptureHitSummary {
  kind?: string;
  url?: string;
  status?: number;
  ok?: boolean;
  contentType?: string | null;
  chars?: number;
  title?: string | null;
  conversation_id?: string | null;
  mappingCount?: number | null;
  current_node?: string | null;
  bodyPreview?: string;
}

interface CapturePollResult {
  href?: string;
  title?: string;
  hit?: CaptureHitSummary | null;
  hits?: CaptureHitSummary[];
}

type EvaluateExpression = <T>(expression: string, timeoutLabel?: string) => Promise<T>;

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "OPENAI_API_KEY assignment", pattern: /OPENAI_API_KEY\s*[:=]\s*\S+/i },
  { label: "ANTHROPIC_API_KEY assignment", pattern: /ANTHROPIC_API_KEY\s*[:=]\s*\S+/i },
  { label: "API_KEY assignment", pattern: /\bAPI_KEY\s*[:=]\s*\S+/i },
  { label: "SECRET assignment", pattern: /\bSECRET\s*[:=]\s*\S+/i },
  { label: "TOKEN assignment", pattern: /\bTOKEN\s*[:=]\s*\S+/i },
  { label: "PASSWORD assignment", pattern: /\bPASSWORD\s*[:=]\s*\S+/i },
  { label: "private key", pattern: /-----BEGIN PRIVATE KEY-----/ },
  { label: "ghp token", pattern: /\bghp_[A-Za-z0-9_]{20,}\b/ },
  { label: "xoxb token", pattern: /\bxoxb-[A-Za-z0-9-]{20,}\b/ },
  { label: "sk token", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
];

const SECRET_MARKER_MENTIONS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "API_KEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
];

export function conversationIdFromChatGptUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("target-url must be https://chatgpt.com/c/<conversation-id>");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com") {
    throw new Error("target-url must be https://chatgpt.com/c/<conversation-id>");
  }
  const match = /^\/c\/([^/?#]+)\/?$/.exec(parsed.pathname);
  if (!match?.[1]) {
    throw new Error("target-url must be a specific https://chatgpt.com/c/<conversation-id> URL");
  }
  return match[1];
}

export function buildBackendConversationUrl(conversationId: string): string {
  return `https://chatgpt.com/backend-api/conversation/${conversationId}`;
}

export function isSameConversationUrl(actualUrl: string, expectedConversationId: string): boolean {
  try {
    return conversationIdFromChatGptUrl(actualUrl) === expectedConversationId;
  } catch {
    return false;
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

export function buildScopedBackendCaptureHook(targetApiUrl: string): string {
  return `
(() => {
  const TARGET = ${jsString(targetApiUrl)};
  window.__oracleChatGptBackendCapture = { target: TARGET, hits: [] };
  const record = async (kind, input, response) => {
    try {
      const url = new URL(typeof input === "string" ? input : (input && input.url) || "", location.href).href;
      if (url !== TARGET) return;
      const text = await response.clone().text();
      window.__oracleChatGptBackendCapture.hits.push({
        kind,
        url,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type"),
        chars: text.length,
        text,
        capturedAt: new Date().toISOString()
      });
    } catch (error) {
      try {
        window.__oracleChatGptBackendCapture.hits.push({ kind, error: String(error), capturedAt: new Date().toISOString() });
      } catch {}
    }
  };
  const originalFetch = window.fetch;
  window.fetch = async function(input, init) {
    const response = await originalFetch.apply(this, arguments);
    record("fetch", input, response);
    return response;
  };
  const OriginalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OriginalXHR();
    let requestUrl = "";
    const open = xhr.open;
    xhr.open = function(method, url) {
      requestUrl = String(url || "");
      return open.apply(xhr, arguments);
    };
    xhr.addEventListener("loadend", () => {
      try {
        const href = new URL(requestUrl, location.href).href;
        if (href !== TARGET) return;
        window.__oracleChatGptBackendCapture.hits.push({
          kind: "xhr",
          url: href,
          status: xhr.status,
          ok: xhr.status >= 200 && xhr.status < 300,
          contentType: xhr.getResponseHeader("content-type"),
          chars: String(xhr.responseText || "").length,
          text: String(xhr.responseText || ""),
          capturedAt: new Date().toISOString()
        });
      } catch {}
    });
    return xhr;
  };
})();
`.trim();
}

async function evaluateByValue<T>(
  Runtime: ChromeClient["Runtime"],
  expression: string,
  timeoutLabel = "Runtime.evaluate",
): Promise<T> {
  const result = await Runtime.evaluate({
    expression,
    awaitPromise: false,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`${timeoutLabel} failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result?.value as T;
}

async function runObuCdp(
  sessionId: string,
  tabId: string,
  method: string,
  params: JsonRecord,
  timeout = "60s",
): Promise<JsonRecord> {
  const { stdout, stderr } = await execFileAsync(
    "obu",
    [
      "cdp",
      "--session-id",
      sessionId,
      "--tab-id",
      tabId,
      "--method",
      method,
      "--params",
      JSON.stringify(params),
      "--timeout",
      timeout,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  let envelope: JsonRecord;
  try {
    envelope = JSON.parse(stdout) as JsonRecord;
  } catch (error) {
    throw new Error(
      `obu cdp ${method} returned non-JSON output: ${stderr || stdout || String(error)}`,
    );
  }
  if (envelope.error) {
    throw new Error(`obu cdp ${method} failed: ${JSON.stringify(envelope.error)}`);
  }
  return asRecord(envelope.result);
}

async function evaluateObuByValue<T>(
  sessionId: string,
  tabId: string,
  expression: string,
  timeoutLabel = "Runtime.evaluate",
): Promise<T> {
  const result = await runObuCdp(
    sessionId,
    tabId,
    "Runtime.evaluate",
    { expression, awaitPromise: false, returnByValue: true },
    "60s",
  );
  if (result.exceptionDetails) {
    throw new Error(`${timeoutLabel} failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return asRecord(result.result).value as T;
}

async function pollCaptureWithEvaluator(
  evaluate: EvaluateExpression,
  targetApiUrl: string,
  timeoutMs: number,
): Promise<CapturePollResult> {
  const deadline = Date.now() + timeoutMs;
  let last: CapturePollResult = {};
  const expression = `
(() => {
  const target = ${jsString(targetApiUrl)};
  const hits = window.__oracleChatGptBackendCapture?.hits || [];
  const summaries = hits.map((hit) => {
    const text = String(hit.text || "");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return {
      kind: hit.kind,
      url: hit.url,
      status: hit.status,
      ok: hit.ok,
      contentType: hit.contentType,
      chars: text.length,
      title: parsed?.title || null,
      conversation_id: parsed?.conversation_id || null,
      mappingCount: parsed?.mapping ? Object.keys(parsed.mapping).length : null,
      current_node: parsed?.current_node || null,
      bodyPreview: text.slice(0, 120)
    };
  });
  const match = summaries.find((hit) => hit.url === target && hit.status === 200 && hit.conversation_id);
  return { href: location.href, title: document.title, hit: match || null, hits: summaries };
})()
`;
  while (Date.now() < deadline) {
    last = await evaluate<CapturePollResult>(expression, "capture poll");
    if (last?.hit) {
      return last;
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for backend conversation capture: ${JSON.stringify(last)}`);
}

async function pollCapture(
  Runtime: ChromeClient["Runtime"],
  targetApiUrl: string,
  timeoutMs: number,
): Promise<CapturePollResult> {
  return pollCaptureWithEvaluator(
    <T>(expression: string, timeoutLabel?: string) =>
      evaluateByValue<T>(Runtime, expression, timeoutLabel),
    targetApiUrl,
    timeoutMs,
  );
}

async function retrieveCapturedTextWithEvaluator(
  evaluate: EvaluateExpression,
  targetApiUrl: string,
  chars: number,
  chunkSize: number,
): Promise<string> {
  const parts: string[] = [];
  for (let start = 0; start < chars; start += chunkSize) {
    const end = Math.min(start + chunkSize, chars);
    const expression = `
(() => {
  const target = ${jsString(targetApiUrl)};
  const hits = window.__oracleChatGptBackendCapture?.hits || [];
  const hit = hits.find((item) => item.url === target && item.status === 200 && String(item.text || "").startsWith("{"));
  if (!hit) return null;
  return String(hit.text || "").slice(${start}, ${end});
})()
`;
    const part = await evaluate<string | null>(expression, "capture chunk");
    if (typeof part !== "string") {
      throw new Error(`Missing captured text chunk ${start}:${end}`);
    }
    parts.push(part);
  }
  return parts.join("");
}

async function retrieveCapturedText(
  Runtime: ChromeClient["Runtime"],
  targetApiUrl: string,
  chars: number,
  chunkSize: number,
): Promise<string> {
  return retrieveCapturedTextWithEvaluator(
    <T>(expression: string, timeoutLabel?: string) =>
      evaluateByValue<T>(Runtime, expression, timeoutLabel),
    targetApiUrl,
    chars,
    chunkSize,
  );
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function pathFromMapping(
  mapping: Record<string, BackendNode>,
  currentNode: string | undefined,
): string[] {
  let nodeId: string | undefined = currentNode;
  const out: string[] = [];
  const seen = new Set<string>();
  while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
    seen.add(nodeId);
    out.push(nodeId);
    const parent = mapping[nodeId]?.parent;
    nodeId = typeof parent === "string" ? parent : undefined;
  }
  const reversed: string[] = [];
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const nodeId = out[index];
    if (nodeId) {
      reversed.push(nodeId);
    }
  }
  return reversed;
}

export function contentToText(content: JsonRecord): string {
  const contentType = String(content.content_type ?? "");
  if (contentType === "text") {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    return parts
      .map((part) => (typeof part === "string" ? part : JSON.stringify(part, null, 2)))
      .join("\n")
      .trim();
  }
  if (contentType === "code" || contentType === "execution_output") {
    return String(content.text ?? "").trim();
  }
  if (contentType === "reasoning_recap") {
    const value = content.content;
    return typeof value === "string" ? value.trim() : JSON.stringify(value ?? content, null, 2);
  }
  if (contentType === "thoughts") {
    return JSON.stringify(content.thoughts ?? content, null, 2).trim();
  }
  if (contentType === "tether_browsing_display") {
    return JSON.stringify(
      {
        summary: content.summary,
        result: content.result,
        assets: content.assets,
        tether_id: content.tether_id,
      },
      null,
      2,
    ).trim();
  }
  if (contentType === "model_editable_context") {
    return JSON.stringify(content, null, 2).trim();
  }
  return JSON.stringify(content, null, 2).trim();
}

function attachmentRecords(metadata: JsonRecord): JsonRecord[] {
  const raw = Array.isArray(metadata.attachments) ? metadata.attachments : [];
  return raw.flatMap((entry) => {
    const attachment = asRecord(entry);
    if (Object.keys(attachment).length === 0) {
      return [];
    }
    return [
      {
        label:
          attachment.name ??
          attachment.file_name ??
          attachment.id ??
          attachment.file_id ??
          "attachment",
        url: attachment.download_url ?? attachment.url ?? "",
        content_type: attachment.mime_type ?? attachment.content_type,
        source: "backend_metadata",
      },
    ];
  });
}

export function backendToPayload(
  backend: BackendConversation,
  targetUrl: string,
  rawSha256: string,
  rawBytes: number,
): JsonRecord {
  const mapping = backend.mapping ?? {};
  const currentPath = pathFromMapping(mapping, backend.current_node);
  const turns: JsonRecord[] = [];
  currentPath.forEach((nodeId, ordinal) => {
    const node = mapping[nodeId] ?? {};
    const message = node.message;
    if (!message) {
      return;
    }
    const author = message.author ?? {};
    const content = asRecord(message.content);
    const metadata = asRecord(message.metadata);
    const text = contentToText(content);
    turns.push({
      ordinal,
      role: author.role ?? "unknown",
      name: author.name,
      turn_id: nodeId,
      message_id: message.id,
      parent: node.parent,
      children: node.children ?? [],
      create_time: message.create_time,
      update_time: message.update_time,
      status: message.status,
      channel: message.channel,
      recipient: message.recipient,
      content_type: content.content_type,
      text,
      content,
      metadata,
      attachments: attachmentRecords(metadata),
      visible_status: [],
      extraction_status: "captured_backend_json",
      source: "backend-fetch-capture",
      text_length: text.length,
    });
  });
  const roleValues = new Set(turns.map((turn) => String(turn.role ?? "unknown")));
  const contentTypeValues = new Set(turns.map((turn) => String(turn.content_type ?? "unknown")));
  const stats = {
    turn_count: turns.length,
    user_turns: turns.filter((turn) => turn.role === "user").length,
    assistant_turns: turns.filter((turn) => turn.role === "assistant").length,
    tool_turns: turns.filter((turn) => turn.role === "tool").length,
    system_turns: turns.filter((turn) => turn.role === "system").length,
    mapping_node_count: Object.keys(mapping).length,
    current_path_node_count: currentPath.length,
    content_types: Object.fromEntries(
      [...contentTypeValues]
        .sort()
        .map((value) => [
          value,
          turns.filter((turn) => String(turn.content_type ?? "unknown") === value).length,
        ]),
    ),
    roles: Object.fromEntries(
      [...roleValues]
        .sort()
        .map((value) => [
          value,
          turns.filter((turn) => String(turn.role ?? "unknown") === value).length,
        ]),
    ),
    asset_candidates: turns.reduce(
      (count, turn) => count + (Array.isArray(turn.attachments) ? turn.attachments.length : 0),
      0,
    ),
    downloaded_assets: 0,
  };
  const expectedConversationId = conversationIdFromChatGptUrl(targetUrl);
  return {
    schema_version: "oracle.chatgpt-conversation-export.v1",
    exported_at: new Date().toISOString(),
    target_url: targetUrl,
    final_url: targetUrl,
    title: backend.title,
    conversation_id: backend.conversation_id,
    expected_conversation_id: expectedConversationId,
    scope_ok: backend.conversation_id === expectedConversationId,
    extraction_method: "backend-fetch-capture-during-page-load",
    limitations: [
      "Captures ChatGPT backend conversation JSON for the exact approved conversation id during the page's own load request.",
      "Does not read browser cookies, localStorage, profile stores, or unrelated conversation history.",
      "Includes backend-only nodes such as tool events, thoughts, reasoning recaps, and hidden/system messages when present in the conversation payload.",
      "Does not claim real-world authorship or content beyond the captured ChatGPT backend payload.",
    ],
    backend_probe: {
      attempted: true,
      method: "document_start_fetch_clone_on_reload",
      status: "captured",
      raw_backend_sha256: rawSha256,
      raw_backend_size_bytes: rawBytes,
      mapping_count: Object.keys(mapping).length,
      current_path_node_count: currentPath.length,
    },
    stats,
    turns,
    asset_candidates: turns.flatMap((turn) =>
      Array.isArray(turn.attachments) ? turn.attachments : [],
    ),
    downloaded_assets: [],
    backend_conversation_top_level_keys: Object.keys(backend),
    raw_backend_sha256: rawSha256,
  };
}

function markdownForPayload(payload: JsonRecord): string {
  const turns = Array.isArray(payload.turns) ? (payload.turns as JsonRecord[]) : [];
  const lines: string[] = [
    "# ChatGPT Conversation Export",
    "",
    `- Target URL: ${payload.target_url ?? ""}`,
    `- Conversation ID: ${payload.conversation_id ?? ""}`,
    `- Title: ${payload.title ?? ""}`,
    `- Exported at: ${payload.exported_at ?? ""}`,
    `- Extraction method: ${payload.extraction_method ?? ""}`,
    `- Raw backend SHA-256: ${payload.raw_backend_sha256 ?? ""}`,
    "",
    "## Non-Claims",
    "",
    "- This export is scoped to the explicitly approved conversation URL.",
    "- It does not read cookies, localStorage, browser profiles, or unrelated ChatGPT history.",
    "- It does not prove real-world authorship beyond the captured ChatGPT backend payload.",
    "",
    "## Turns",
    "",
  ];
  for (const turn of turns) {
    const ordinal = String(turn.ordinal ?? "").padStart(4, "0");
    lines.push(
      `### ${ordinal} ${turn.role ?? "unknown"} / ${turn.content_type ?? "unknown"}`,
      "",
      `- Turn ID: ${turn.turn_id ?? ""}`,
      `- Message ID: ${turn.message_id ?? ""}`,
      `- Channel: ${turn.channel ?? ""}`,
      `- Recipient: ${turn.recipient ?? ""}`,
      "",
      "```text",
      String(turn.text ?? ""),
      "```",
      "",
    );
  }
  return lines.join("\n");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function scanTextForSecretLikeMarkers(
  relativePath: string,
  text: string,
): { findings: JsonRecord[]; warnings: string[] } {
  const findings = SECRET_PATTERNS.flatMap(({ label, pattern }) =>
    pattern.test(text) ? [{ path: relativePath, marker: label }] : [],
  );
  const warnings = SECRET_MARKER_MENTIONS.flatMap((marker) =>
    text.includes(marker) ? [`marker mention present in ${relativePath}: ${marker}`] : [],
  );
  return { findings, warnings };
}

async function buildRedactionReport(outDir: string, files: string[]): Promise<JsonRecord> {
  const findings: JsonRecord[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    const absolute = path.join(outDir, file);
    const text = await fs.readFile(absolute, "utf8");
    const scan = scanTextForSecretLikeMarkers(file, text);
    findings.push(...scan.findings);
    warnings.push(...scan.warnings);
  }
  return {
    schema_version: "oracle.chatgpt-conversation-export.redaction-report.v1",
    created_at: new Date().toISOString(),
    ok: findings.length === 0,
    scanned_files: files,
    findings,
    warnings,
    non_claims: [
      "This scan checks exported bundle text for common secret-like markers.",
      "It does not inspect browser cookies, localStorage, profile stores, or unrelated files.",
    ],
  };
}

async function writeSha256Sums(outDir: string, files: string[]): Promise<string> {
  const lines: string[] = [];
  for (const file of files) {
    const absolute = path.join(outDir, file);
    lines.push(`${await sha256File(absolute)}  ${file}`);
  }
  const sumsPath = path.join(outDir, "SHA256SUMS.txt");
  await fs.writeFile(sumsPath, `${lines.join("\n")}\n`, "utf8");
  return sumsPath;
}

async function writeBundle({
  outDir,
  rawText,
  payload,
  captureInfo,
}: {
  outDir: string;
  rawText: string;
  payload: JsonRecord;
  captureInfo: JsonRecord;
}): Promise<{
  rawBackendPath: string;
  payloadPath: string;
  markdownPath: string;
  manifestPath: string;
  captureInfoPath: string;
  sha256SumsPath: string;
}> {
  await fs.mkdir(outDir, { recursive: true });
  const rawBackendPath = path.join(outDir, "backend-conversation.json");
  const conversationPath = path.join(outDir, "conversation.json");
  const payloadPath = path.join(outDir, "payload.json");
  const markdownPath = path.join(outDir, "conversation.md");
  const manifestPath = path.join(outDir, "manifest.json");
  const captureInfoPath = path.join(outDir, "backend-capture-info.json");
  const redactionReportPath = path.join(outDir, "redaction-report.json");
  const stats = asRecord(payload.stats);
  const files = [
    "backend-conversation.json",
    "backend-capture-info.json",
    "conversation.json",
    "payload.json",
    "conversation.md",
    "manifest.json",
    "redaction-report.json",
  ];
  await fs.writeFile(rawBackendPath, rawText, "utf8");
  await writeJson(conversationPath, payload);
  await writeJson(payloadPath, payload);
  await fs.writeFile(markdownPath, markdownForPayload(payload), "utf8");
  await writeJson(captureInfoPath, captureInfo);
  await writeJson(manifestPath, {
    schema_version: "oracle.chatgpt-conversation-export.manifest.v1",
    created_at: new Date().toISOString(),
    target_url: payload.target_url,
    final_url: payload.final_url,
    conversation_id: payload.conversation_id,
    expected_conversation_id: payload.expected_conversation_id,
    scope_ok: payload.scope_ok === true,
    extraction_method: payload.extraction_method,
    turn_count: stats.turn_count,
    user_turns: stats.user_turns,
    assistant_turns: stats.assistant_turns,
    tool_turns: stats.tool_turns,
    system_turns: stats.system_turns,
    stats,
    backend_probe: payload.backend_probe,
    files,
    non_claims: [
      "No cookies, localStorage, profile stores, or unrelated history were read.",
      "The hook captured only the exact target backend conversation URL during page load.",
    ],
  });
  const redactionReport = await buildRedactionReport(outDir, [
    "backend-conversation.json",
    "backend-capture-info.json",
    "conversation.json",
    "payload.json",
    "conversation.md",
    "manifest.json",
  ]);
  await writeJson(redactionReportPath, redactionReport);
  const sha256SumsPath = await writeSha256Sums(outDir, files);
  return {
    rawBackendPath,
    payloadPath,
    markdownPath,
    manifestPath,
    captureInfoPath,
    sha256SumsPath,
  };
}

async function finalizeCapturedExport({
  backend,
  rawText,
  targetUrl,
  targetApiUrl,
  outDir,
  targetId,
  tabUrl,
  captureInfo,
}: {
  backend: BackendConversation;
  rawText: string;
  targetUrl: string;
  targetApiUrl: string;
  outDir: string;
  targetId: string;
  tabUrl: string;
  captureInfo: JsonRecord;
}): Promise<ChatGptConversationExportResult> {
  const conversationId = conversationIdFromChatGptUrl(targetUrl);
  if (backend.conversation_id !== conversationId) {
    throw new Error(`Captured wrong conversation id: ${backend.conversation_id ?? "(missing)"}`);
  }
  const rawBackendSha256 = hashText(rawText);
  const rawBackendSizeBytes = Buffer.byteLength(rawText, "utf8");
  const payload = backendToPayload(backend, targetUrl, rawBackendSha256, rawBackendSizeBytes);
  const bundle = await writeBundle({
    outDir,
    rawText,
    payload,
    captureInfo: {
      ...captureInfo,
      raw_backend_sha256: rawBackendSha256,
      raw_backend_size_bytes: rawBackendSizeBytes,
    },
  });
  const stats = asRecord(payload.stats);
  return {
    ok: true,
    outputDir: outDir,
    targetUrl,
    targetApiUrl,
    conversationId,
    title: backend.title,
    targetId,
    tabUrl,
    rawBackendPath: bundle.rawBackendPath,
    rawBackendSha256,
    rawBackendSizeBytes,
    payloadPath: bundle.payloadPath,
    markdownPath: bundle.markdownPath,
    manifestPath: bundle.manifestPath,
    captureInfoPath: bundle.captureInfoPath,
    sha256SumsPath: bundle.sha256SumsPath,
    mappingCount: Object.keys(backend.mapping ?? {}).length,
    currentPathNodeCount: Number(stats.current_path_node_count ?? 0),
    turnCount: Number(stats.turn_count ?? 0),
    stats,
  };
}

export async function captureApprovedChatGptConversationBackend(
  options: ChatGptConversationExportOptions,
): Promise<ChatGptConversationExportResult> {
  const conversationId = conversationIdFromChatGptUrl(options.targetUrl);
  const targetApiUrl = buildBackendConversationUrl(conversationId);
  const host = options.host ?? DEFAULT_REMOTE_CHROME_HOST;
  const port = options.port ?? DEFAULT_REMOTE_CHROME_PORT;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const chunkSize = options.chunkSize ?? 250_000;
  const tabRef = options.tabRef ?? options.targetUrl;
  const outDir = path.resolve(options.outDir);

  const { client, targetId, tab } = await connectToExistingChatGptTab({ host, port, ref: tabRef });
  try {
    const { Page, Runtime } = client;
    if (!isSameConversationUrl(tab.url, conversationId)) {
      throw new Error(
        `Resolved ChatGPT tab is not the approved target conversation; expected ${conversationId}, got ${tab.url}`,
      );
    }
    await Page.addScriptToEvaluateOnNewDocument({
      source: buildScopedBackendCaptureHook(targetApiUrl),
    });
    await Page.enable();
    await Page.reload({ ignoreCache: true });
    const capture = await pollCapture(Runtime, targetApiUrl, timeoutMs);
    const hit = capture.hit;
    if (!hit?.chars || hit.conversation_id !== conversationId) {
      throw new Error(
        `Capture did not return the approved conversation id: ${JSON.stringify(hit)}`,
      );
    }
    const rawText = await retrieveCapturedText(Runtime, targetApiUrl, hit.chars, chunkSize);
    const backend = JSON.parse(rawText) as BackendConversation;
    return await finalizeCapturedExport({
      backend,
      rawText,
      targetUrl: options.targetUrl,
      targetApiUrl,
      outDir,
      targetId,
      tabUrl: tab.url,
      captureInfo: {
        captured_at: new Date().toISOString(),
        target_url: options.targetUrl,
        target_api_url: targetApiUrl,
        tab: {
          host,
          port,
          target_id: targetId,
          url_before_reload: tab.url,
          title_before_reload: tab.title,
        },
        hit: Object.fromEntries(Object.entries(hit).filter(([key]) => key !== "bodyPreview")),
        non_claims: [
          "No cookies, localStorage, profile stores, or unrelated history were read.",
          "The hook captured only the exact target backend conversation URL during page load.",
        ],
      },
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function captureApprovedChatGptConversationBackendViaObu(
  options: ChatGptConversationExportObuOptions,
): Promise<ChatGptConversationExportResult> {
  const conversationId = conversationIdFromChatGptUrl(options.targetUrl);
  const targetApiUrl = buildBackendConversationUrl(conversationId);
  const sessionId = options.sessionId ?? "obu-mcp";
  const timeoutMs = options.timeoutMs ?? 45_000;
  const chunkSize = options.chunkSize ?? 250_000;
  const outDir = path.resolve(options.outDir);
  const evaluate: EvaluateExpression = <T>(expression: string, timeoutLabel?: string) =>
    evaluateObuByValue<T>(sessionId, options.tabId, expression, timeoutLabel);
  const currentUrl = await evaluate<string>("location.href", "current URL check");
  if (!isSameConversationUrl(currentUrl, conversationId)) {
    throw new Error(
      `Resolved OBU tab is not the approved target conversation; expected ${conversationId}, got ${currentUrl}`,
    );
  }

  await runObuCdp(
    sessionId,
    options.tabId,
    "Page.addScriptToEvaluateOnNewDocument",
    { source: buildScopedBackendCaptureHook(targetApiUrl) },
    "60s",
  );
  await runObuCdp(sessionId, options.tabId, "Page.enable", {}, "60s");
  await runObuCdp(sessionId, options.tabId, "Page.reload", { ignoreCache: true }, "60s");
  const capture = await pollCaptureWithEvaluator(evaluate, targetApiUrl, timeoutMs);
  const hit = capture.hit;
  if (!hit?.chars || hit.conversation_id !== conversationId) {
    throw new Error(`Capture did not return the approved conversation id: ${JSON.stringify(hit)}`);
  }
  const rawText = await retrieveCapturedTextWithEvaluator(
    evaluate,
    targetApiUrl,
    hit.chars,
    chunkSize,
  );
  const backend = JSON.parse(rawText) as BackendConversation;
  return await finalizeCapturedExport({
    backend,
    rawText,
    targetUrl: options.targetUrl,
    targetApiUrl,
    outDir,
    targetId: `obu:${sessionId}:${options.tabId}`,
    tabUrl: currentUrl,
    captureInfo: {
      captured_at: new Date().toISOString(),
      target_url: options.targetUrl,
      target_api_url: targetApiUrl,
      tab: {
        transport: "obu",
        session_id: sessionId,
        tab_id: options.tabId,
        url_before_reload: currentUrl,
      },
      hit: Object.fromEntries(Object.entries(hit).filter(([key]) => key !== "bodyPreview")),
      non_claims: [
        "No cookies, localStorage, profile stores, or unrelated history were read.",
        "The hook captured only the exact target backend conversation URL during page load.",
      ],
    },
  });
}
