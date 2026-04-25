import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import CDP from "chrome-remote-interface";
import type { Browser, Locator, Page } from "playwright-core";
import type { BrowserDownloadedFile } from "../sessionStore.js";
import { ASSISTANT_ROLE_SELECTOR, CONVERSATION_TURN_SELECTOR } from "./constants.js";
import {
  extractConversationIdFromUrl,
  pickTarget,
  type TargetInfoLite,
} from "./reattachHelpers.js";
import { connectPlaywrightSupervisor, normalizeSupervisorPageUrl } from "./playwrightSupervisor.js";
import { buildThreadIntrospectionHelpers } from "./threadIntrospection.js";
import type { BrowserLogger, ChromeClient } from "./types.js";

const DOWNLOAD_CANDIDATE_SELECTOR = 'a, button, [role="button"], [role="link"]';
const DOWNLOAD_EVENT_TIMEOUT_MS = 10_000;
const CLICK_TIMEOUT_MS = 5_000;
const DOWNLOAD_PREVIEW_SETTLE_MS = 1_000;
const FILE_NAME_PATTERN =
  /\.(?:txt|csv|md|markdown|json|zip|pdf|png|jpg|jpeg|gif|svg|html|xml|yaml|yml|toml|log|py|js|ts|tsx|rs)\b/i;

export interface AssistantDownloadCaptureOptions {
  browserWSEndpoint?: string | null;
  chromeHost?: string;
  chromePort?: number;
  chromeTargetId?: string;
  tabUrl?: string;
  conversationId?: string;
  downloadsDir?: string;
  assistantMarkdown?: string;
  meta?: { turnId?: string | null; messageId?: string | null };
  targetClient?: ChromeClient;
  logger?: BrowserLogger;
}

interface DownloadCandidateDescriptor {
  index: number;
  fingerprint: string;
  score: number;
}

interface DownloadEventInfo {
  guid?: string;
  suggestedFilename?: string;
}

interface DownloadProgressInfo {
  guid?: string;
  state?: string;
  filePath?: string;
}

interface DownloadCandidateInput {
  tagName?: string;
  text?: string;
  ariaLabel?: string;
  title?: string;
  href?: string;
  downloadAttr?: string;
  testId?: string;
}

interface PageSelectionCandidate {
  index: number;
  normalizedUrl?: string;
  conversationId?: string;
  targetId?: string;
}

interface PageSelectionResult {
  index: number;
  reason: string;
}

type EventedChromeClient = ChromeClient & {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
};
type CandidateCollectionMode = "scope" | "document";
type ChromeClientWithEmulation = ChromeClient & {
  Emulation?: {
    setDeviceMetricsOverride?: (params: {
      width: number;
      height: number;
      deviceScaleFactor: number;
      mobile: boolean;
    }) => Promise<unknown>;
  };
};

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function candidateFingerprint(candidate: DownloadCandidateInput): string {
  return [
    normalizeText(candidate.tagName),
    normalizeText(candidate.text),
    normalizeText(candidate.ariaLabel),
    normalizeText(candidate.title),
    normalizeText(candidate.href),
    normalizeText(candidate.downloadAttr),
    normalizeText(candidate.testId),
  ].join("|");
}

function scoreDownloadCandidate(candidate: DownloadCandidateInput): number {
  const text = normalizeText(candidate.text);
  const ariaLabel = normalizeText(candidate.ariaLabel);
  const title = normalizeText(candidate.title);
  const href = String(candidate.href ?? "")
    .trim()
    .toLowerCase();
  const downloadAttr = String(candidate.downloadAttr ?? "")
    .trim()
    .toLowerCase();
  const testId = normalizeText(candidate.testId);
  const tags = [text, ariaLabel, title, downloadAttr, href, testId].join(" ");
  const explicitDownload =
    downloadAttr.length > 0 ||
    href.startsWith("blob:") ||
    href.startsWith("sandbox:/mnt/data/") ||
    href.includes("/backend-api/files/") ||
    href.includes("/backend-api/download/") ||
    /\bdownload\b/.test(tags);
  const fileLike = FILE_NAME_PATTERN.test(tags);
  if (!explicitDownload && !fileLike) {
    return 0;
  }
  let score = 0;
  if (downloadAttr.length > 0) score += 8;
  if (href.startsWith("blob:")) score += 8;
  if (href.startsWith("sandbox:/mnt/data/")) score += 8;
  if (href.includes("/backend-api/files/") || href.includes("/backend-api/download/")) score += 7;
  if (/\bdownload\b/.test(`${ariaLabel} ${title} ${testId}`)) score += 6;
  if (/\bdownload\b/.test(text)) score += 4;
  if (fileLike) score += 3;
  if (candidate.tagName?.toLowerCase() === "a") score += 1;
  return score;
}

function sanitizeSuggestedFilename(filename: string | null | undefined): string {
  const base = path.basename(String(filename ?? "").trim()) || "download";
  return base.replace(/[\\/:*?"<>|]/g, "_");
}

function targetIdentity(target: TargetInfoLite | undefined): string | undefined {
  if (!target) {
    return undefined;
  }
  const targetId = target.targetId;
  if (typeof targetId === "string" && targetId.length > 0) {
    return targetId;
  }
  const legacyId = target.id;
  return typeof legacyId === "string" && legacyId.length > 0 ? legacyId : undefined;
}

function summarizeTargets(targets: TargetInfoLite[]): string {
  if (!Array.isArray(targets) || targets.length === 0) {
    return "(none)";
  }
  return targets
    .map((target) => {
      const id = targetIdentity(target) ?? "unknown";
      const url = normalizeSupervisorPageUrl(target.url) ?? target.url ?? "about:blank";
      return `${target.type ?? "unknown"}:${id}:${url}`;
    })
    .join(", ");
}

function summarizePageCandidates(candidates: PageSelectionCandidate[]): string {
  if (candidates.length === 0) {
    return "(none)";
  }
  return candidates
    .map(
      (candidate) =>
        `${candidate.index}:${candidate.targetId ?? "unknown"}:${candidate.normalizedUrl ?? "about:blank"}`,
    )
    .join(", ");
}

function projectFamilyKey(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const match = pathname.match(
      /^\/g\/([^/]+)(?:\/project(?:\/c\/[a-zA-Z0-9-]+)?|\/c\/[a-zA-Z0-9-]+)$/i,
    );
    return match?.[1]?.toLowerCase()?.replace(/-oracle$/i, "") ?? null;
  } catch {
    return null;
  }
}

function pickDirectDownloadTarget(
  targets: TargetInfoLite[],
  runtime: Pick<AssistantDownloadCaptureOptions, "chromeTargetId" | "tabUrl" | "conversationId">,
): TargetInfoLite | undefined {
  if (!Array.isArray(targets) || targets.length === 0) {
    return undefined;
  }
  const runtimeConversationId =
    runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? "");
  const runtimeFamily = projectFamilyKey(runtime.tabUrl);
  if (runtimeConversationId) {
    const conversationMatches = targets.filter((target) => {
      if (extractConversationIdFromUrl(target.url || "") !== runtimeConversationId) {
        return false;
      }
      return !runtimeFamily || projectFamilyKey(target.url) === runtimeFamily;
    });
    if (conversationMatches.length === 1) {
      return conversationMatches[0];
    }
    const preferredConversationTarget = conversationMatches.find(
      (target) => target.type && target.type !== "page",
    );
    if (preferredConversationTarget) {
      return preferredConversationTarget;
    }
  }
  if (runtime.chromeTargetId) {
    return targets.find((target) => targetIdentity(target) === runtime.chromeTargetId);
  }
  if (runtime.tabUrl) {
    const normalizedRuntimeUrl = normalizeSupervisorPageUrl(runtime.tabUrl);
    return targets.find(
      (target) => normalizeSupervisorPageUrl(target.url) === normalizedRuntimeUrl,
    );
  }
  return undefined;
}

function removeEventListener(
  client: EventedChromeClient,
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  if (client.off) {
    client.off(event, listener);
    return;
  }
  client.removeListener(event, listener);
}

function isLocalHost(value: string | null | undefined): boolean {
  const host = String(value ?? "")
    .trim()
    .toLowerCase();
  return host === "" || host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isLocalEndpoint(
  browserWSEndpoint: string | null | undefined,
  chromeHost?: string,
): boolean {
  const endpoint = String(browserWSEndpoint ?? "").trim();
  if (endpoint) {
    try {
      return isLocalHost(new URL(endpoint).hostname);
    } catch {
      return false;
    }
  }
  return isLocalHost(chromeHost);
}

async function resolveUniqueDownloadPath(
  downloadsDir: string,
  suggestedFilename: string,
): Promise<string> {
  const parsed = path.parse(suggestedFilename);
  const stem = parsed.name || "download";
  const ext = parsed.ext || "";
  for (let index = 0; ; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = path.join(downloadsDir, `${stem}${suffix}${ext}`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
}

async function resolveAssistantTurnScope(
  page: Page,
  meta: AssistantDownloadCaptureOptions["meta"],
): Promise<Locator | null> {
  if (!page) {
    return null;
  }
  const messageId = meta?.messageId?.trim();
  if (messageId) {
    const locator = page.locator(`[data-message-id="${escapeAttributeValue(messageId)}"]`).last();
    if ((await locator.count()) > 0) {
      return locator;
    }
  }
  const turnId = meta?.turnId?.trim();
  if (turnId) {
    const locator = page.locator(`[data-testid="${escapeAttributeValue(turnId)}"]`).last();
    if ((await locator.count()) > 0) {
      return locator;
    }
  }
  const fallback = page
    .locator(CONVERSATION_TURN_SELECTOR)
    .filter({ has: page.locator(ASSISTANT_ROLE_SELECTOR) })
    .last();
  return (await fallback.count()) > 0 ? fallback : null;
}

async function collectDownloadCandidates(scope: Locator): Promise<DownloadCandidateDescriptor[]> {
  const candidates = scope.locator(DOWNLOAD_CANDIDATE_SELECTOR);
  const raw = await candidates.evaluateAll((nodes) =>
    nodes.map((node, index) => {
      const element = node as HTMLElement;
      const anchor = node as HTMLAnchorElement;
      return {
        index,
        tagName: node.tagName,
        text: (element.innerText || element.textContent || "").trim(),
        ariaLabel: element.getAttribute("aria-label") || "",
        title: element.getAttribute("title") || "",
        href: anchor.href || "",
        downloadAttr: element.getAttribute("download") || "",
        testId: element.getAttribute("data-testid") || "",
      };
    }),
  );
  const seen = new Set<string>();
  return raw
    .map((candidate) => ({
      index: candidate.index,
      fingerprint: candidateFingerprint(candidate),
      score: scoreDownloadCandidate(candidate),
    }))
    .filter((candidate) => candidate.score > 0)
    .filter((candidate) => {
      if (seen.has(candidate.fingerprint)) {
        return false;
      }
      seen.add(candidate.fingerprint);
      return true;
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);
}

function collectDownloadCandidatesFromInputs(
  raw: DownloadCandidateInput[],
): DownloadCandidateDescriptor[] {
  const seen = new Set<string>();
  return raw
    .map((candidate, index) => ({
      index,
      fingerprint: candidateFingerprint(candidate),
      score: scoreDownloadCandidate(candidate),
    }))
    .filter((candidate) => candidate.score > 0)
    .filter((candidate) => {
      if (seen.has(candidate.fingerprint)) {
        return false;
      }
      seen.add(candidate.fingerprint);
      return true;
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);
}

function buildAssistantScopeExpression(meta: AssistantDownloadCaptureOptions["meta"]): string {
  return `(() => {
    ${buildThreadIntrospectionHelpers()}
    const messageId = ${JSON.stringify(meta?.messageId ?? null)};
    const turnId = ${JSON.stringify(meta?.turnId ?? null)};
    const collectMatches = (root, selector) => {
      const matches = [];
      const visit = (node) => {
        if (!node || typeof node.querySelectorAll !== 'function') {
          return;
        }
        matches.push(...Array.from(node.querySelectorAll(selector)));
        for (const element of Array.from(node.querySelectorAll('*'))) {
          if (element.shadowRoot) {
            visit(element.shadowRoot);
          }
        }
      };
      visit(root);
      return matches;
    };
    const root = __oraclePickActiveThreadRoot() || __oraclePickThreadRoot() || document.body;
    if (!root) return null;
    const byAttr = (attribute, value) => {
      if (!value) return null;
      return collectMatches(root, \`[\${attribute}]\`).find(
        (node) => node.getAttribute(attribute) === value,
      ) || null;
    };
    const byMessage = byAttr('data-message-id', messageId);
    if (byMessage) return byMessage;
    const byTurn = byAttr('data-testid', turnId);
    if (byTurn) return byTurn;
    const turns = collectMatches(root, ${JSON.stringify(CONVERSATION_TURN_SELECTOR)});
    const assistantSelector = ${JSON.stringify(ASSISTANT_ROLE_SELECTOR)};
    const assistantTurns = turns.filter((node) => {
      try {
        return node.matches?.(assistantSelector) || Boolean(node.querySelector?.(assistantSelector));
      } catch {
        return false;
      }
    });
    return assistantTurns.at(-1) || null;
  })()`;
}

function buildCollectTargetCandidatesExpression(
  meta: AssistantDownloadCaptureOptions["meta"],
  mode: CandidateCollectionMode,
): string {
  return `(() => {
    const collectMatches = (root, selector) => {
      const matches = [];
      const visit = (node) => {
        if (!node || typeof node.querySelectorAll !== 'function') {
          return;
        }
        matches.push(...Array.from(node.querySelectorAll(selector)));
        for (const element of Array.from(node.querySelectorAll('*'))) {
          if (element.shadowRoot) {
            visit(element.shadowRoot);
          }
        }
      };
      visit(root);
      return matches;
    };
    const scopedRoot = ${buildAssistantScopeExpression(meta)};
    const scope = ${
      mode === "document" ? "document.body || document.documentElement" : "scopedRoot"
    };
    if (!scope) {
      return { scopeFound: false, candidates: [] };
    }
    const candidates = collectMatches(scope, ${JSON.stringify(DOWNLOAD_CANDIDATE_SELECTOR)}).map((node) => {
      const element = node;
      return {
        tagName: node.tagName,
        text: (element.innerText || element.textContent || '').trim(),
        ariaLabel: element.getAttribute('aria-label') || '',
        title: element.getAttribute('title') || '',
        href: element.href || '',
        downloadAttr: element.getAttribute('download') || '',
        testId: element.getAttribute('data-testid') || '',
      };
    });
    return { scopeFound: true, candidates };
  })()`;
}

function buildClickTargetCandidateExpression(
  meta: AssistantDownloadCaptureOptions["meta"],
  candidateIndex: number,
  mode: CandidateCollectionMode = "scope",
): string {
  return `(() => {
    const collectMatches = (root, selector) => {
      const matches = [];
      const visit = (node) => {
        if (!node || typeof node.querySelectorAll !== 'function') {
          return;
        }
        matches.push(...Array.from(node.querySelectorAll(selector)));
        for (const element of Array.from(node.querySelectorAll('*'))) {
          if (element.shadowRoot) {
            visit(element.shadowRoot);
          }
        }
      };
      visit(root);
      return matches;
    };
    const scope = ${
      mode === "document"
        ? "document.body || document.documentElement"
        : buildAssistantScopeExpression(meta)
    };
    if (!scope) {
      return { clicked: false, reason: 'scope-missing' };
    }
    const nodes = collectMatches(scope, ${JSON.stringify(DOWNLOAD_CANDIDATE_SELECTOR)});
    const node = nodes[${candidateIndex}];
    if (!node) {
      return { clicked: false, reason: 'candidate-missing' };
    }
    try {
      node.scrollIntoView?.({ block: 'center', inline: 'center' });
      node.dispatchEvent?.(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      if (typeof node.click === 'function') {
        node.click();
      }
      return { clicked: true };
    } catch (error) {
      return { clicked: false, reason: String(error || 'click-failed') };
    }
  })()`;
}

function buildTargetCandidateClickPointExpression(
  meta: AssistantDownloadCaptureOptions["meta"],
  candidateIndex: number,
  mode: CandidateCollectionMode = "scope",
): string {
  return `(() => {
    const collectMatches = (root, selector) => {
      const matches = [];
      const visit = (node) => {
        if (!node || typeof node.querySelectorAll !== 'function') {
          return;
        }
        matches.push(...Array.from(node.querySelectorAll(selector)));
        for (const element of Array.from(node.querySelectorAll('*'))) {
          if (element.shadowRoot) {
            visit(element.shadowRoot);
          }
        }
      };
      visit(root);
      return matches;
    };
    const scope = ${
      mode === "document"
        ? "document.body || document.documentElement"
        : buildAssistantScopeExpression(meta)
    };
    if (!scope) {
      return { found: false, reason: 'scope-missing' };
    }
    const nodes = collectMatches(scope, ${JSON.stringify(DOWNLOAD_CANDIDATE_SELECTOR)});
    const node = nodes[${candidateIndex}];
    if (!node) {
      return { found: false, reason: 'candidate-missing' };
    }
    try {
      node.scrollIntoView?.({ block: 'center', inline: 'center' });
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return { found: false, reason: 'candidate-not-visible' };
      }
      const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
      if (viewportWidth <= 0 || viewportHeight <= 0) {
        return { found: false, reason: 'viewport-missing' };
      }
      return {
        found: true,
        x: Math.max(1, Math.min(viewportWidth - 2, rect.left + rect.width / 2)),
        y: Math.max(1, Math.min(viewportHeight - 2, rect.top + rect.height / 2)),
      };
    } catch (error) {
      return { found: false, reason: String(error || 'candidate-point-failed') };
    }
  })()`;
}

async function ensureClickableViewport(client: ChromeClient): Promise<void> {
  const viewportResult = await client.Runtime.evaluate({
    expression: `(() => ({
      width: window.innerWidth || document.documentElement?.clientWidth || 0,
      height: window.innerHeight || document.documentElement?.clientHeight || 0,
    }))()`,
    returnByValue: true,
  }).catch(() => null);
  const viewport = (viewportResult?.result?.value ?? null) as {
    width?: number;
    height?: number;
  } | null;
  if ((viewport?.width ?? 0) > 0 && (viewport?.height ?? 0) > 0) {
    return;
  }
  const emulation = (client as ChromeClientWithEmulation).Emulation;
  await emulation
    ?.setDeviceMetricsOverride?.({
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    })
    .catch(() => undefined);
}

async function collectTargetDownloadCandidates(
  client: ChromeClient,
  meta: AssistantDownloadCaptureOptions["meta"],
  mode: CandidateCollectionMode = "scope",
): Promise<{
  candidates: DownloadCandidateDescriptor[];
  source: "scope" | "document" | "none";
  rawCount: number;
  rawSample: DownloadCandidateInput[];
}> {
  const result = await client.Runtime.evaluate({
    expression: buildCollectTargetCandidatesExpression(meta, mode),
    returnByValue: true,
  });
  const payload = (result.result?.value ?? null) as {
    scopeFound?: boolean;
    candidates?: DownloadCandidateInput[];
  } | null;
  if (payload?.scopeFound && Array.isArray(payload.candidates)) {
    const scopedCandidates = collectDownloadCandidatesFromInputs(payload.candidates);
    if (scopedCandidates.length > 0) {
      return {
        candidates: scopedCandidates,
        source: mode,
        rawCount: payload.candidates.length,
        rawSample: payload.candidates.slice(0, 8),
      };
    }
  }
  if (mode === "document") {
    return {
      candidates: [],
      source: "none",
      rawCount: Array.isArray(payload?.candidates) ? payload.candidates.length : 0,
      rawSample: Array.isArray(payload?.candidates) ? payload.candidates.slice(0, 8) : [],
    };
  }
  const documentResult = await client.Runtime.evaluate({
    expression: buildCollectTargetCandidatesExpression(meta, "document"),
    returnByValue: true,
  });
  const documentPayload = (documentResult.result?.value ?? null) as {
    scopeFound?: boolean;
    candidates?: DownloadCandidateInput[];
  } | null;
  if (!documentPayload?.scopeFound || !Array.isArray(documentPayload.candidates)) {
    return { candidates: [], source: "none", rawCount: 0, rawSample: [] };
  }
  const documentCandidates = collectDownloadCandidatesFromInputs(documentPayload.candidates);
  if (documentCandidates.length > 0) {
    return {
      candidates: documentCandidates,
      source: "document",
      rawCount: documentPayload.candidates.length,
      rawSample: documentPayload.candidates.slice(0, 8),
    };
  }
  return {
    candidates: [],
    source: "none",
    rawCount: documentPayload.candidates.length,
    rawSample: documentPayload.candidates.slice(0, 8),
  };
}

async function clickTargetDownloadCandidate(
  client: ChromeClient,
  meta: AssistantDownloadCaptureOptions["meta"],
  candidateIndex: number,
  mode: CandidateCollectionMode = "scope",
): Promise<{ clicked: boolean; reason?: string }> {
  const input = client.Input;
  if (input && typeof input.dispatchMouseEvent === "function") {
    await ensureClickableViewport(client);
    const pointResult = await client.Runtime.evaluate({
      expression: buildTargetCandidateClickPointExpression(meta, candidateIndex, mode),
      returnByValue: true,
    });
    const point = (pointResult.result?.value ?? null) as {
      found?: boolean;
      x?: number;
      y?: number;
      reason?: string;
    } | null;
    if (!point?.found || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return { clicked: false, reason: point?.reason ?? "candidate-point-missing" };
    }
    const x = point.x as number;
    const y = point.y as number;
    await input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none" });
    await input.dispatchMouseEvent({
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await input.dispatchMouseEvent({
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    return { clicked: true };
  }
  const result = await client.Runtime.evaluate({
    expression: buildClickTargetCandidateExpression(meta, candidateIndex, mode),
    returnByValue: true,
    userGesture: true,
    awaitPromise: true,
  });
  const payload = (result.result?.value ?? null) as { clicked?: boolean; reason?: string } | null;
  return {
    clicked: Boolean(payload?.clicked),
    reason: payload?.reason,
  };
}

async function resolveDownloadedFilePath(
  downloadsDir: string,
  beforeFiles: Set<string>,
  suggestedFilename?: string,
  filePath?: string,
): Promise<string | null> {
  if (filePath) {
    try {
      await stat(filePath);
      return filePath;
    } catch {
      // continue
    }
  }
  const afterFiles = await readdir(downloadsDir).catch(() => []);
  const newFiles = afterFiles.filter((entry) => !beforeFiles.has(entry));
  if (suggestedFilename) {
    const sanitized = sanitizeSuggestedFilename(suggestedFilename);
    if (newFiles.includes(sanitized)) {
      return path.join(downloadsDir, sanitized);
    }
    const suggestedPath = path.join(downloadsDir, sanitized);
    try {
      await stat(suggestedPath);
      return suggestedPath;
    } catch {
      // continue
    }
  }
  if (newFiles.length === 1) {
    return path.join(downloadsDir, newFiles[0]);
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSandboxDownloadNames(markdown: string | undefined): string[] {
  const names = new Set<string>();
  for (const match of String(markdown ?? "").matchAll(/sandbox:\/mnt\/data\/([^)\]\s"'<>]+)/g)) {
    const rawName = match[1]?.trim();
    if (!rawName) {
      continue;
    }
    names.add(sanitizeSuggestedFilename(decodeURIComponent(rawName)));
  }
  return [...names];
}

function projectIdFromUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).pathname.match(/^\/g\/([^/]+)\//i)?.[1] ?? null;
  } catch {
    return null;
  }
}

function collectConversationMessages(conversation: unknown): Array<Record<string, unknown>> {
  if (!conversation || typeof conversation !== "object") {
    return [];
  }
  const mapping = (conversation as { mapping?: unknown }).mapping;
  if (!mapping || typeof mapping !== "object") {
    return [];
  }
  return Object.values(mapping)
    .map((node) =>
      node && typeof node === "object" ? (node as { message?: unknown }).message : null,
    )
    .filter((message): message is Record<string, unknown> =>
      Boolean(message && typeof message === "object"),
    );
}

function extractHeredocContent(text: string, filename: string): string | null {
  if (!text.includes(`/mnt/data/${filename}`)) {
    return null;
  }
  const escapedName = escapeRegExp(filename);
  const match = text.match(
    new RegExp(`/mnt/data/${escapedName}[^\\n]*<<['"]?([A-Za-z0-9_]+)['"]?\\n([\\s\\S]*?)\\n\\1`),
  );
  return match?.[2] ? `${match[2]}\n` : null;
}

function extractToolOutputContent(text: string, filename: string): string | null {
  const targetPath = `/mnt/data/${filename}`;
  if (!text.includes(targetPath)) {
    return null;
  }
  const lines = text.split("\n");
  const pathLine = lines.findIndex((line) => line.includes(targetPath));
  if (pathLine < 0) {
    return null;
  }
  const content = lines.slice(pathLine + 1).join("\n");
  return content.length > 0 ? content : null;
}

function extractSandboxFileContent(conversation: unknown, filename: string): string | null {
  for (const message of collectConversationMessages(conversation)) {
    const content = message.content;
    if (!content || typeof content !== "object") {
      continue;
    }
    const contentRecord = content as Record<string, unknown>;
    const parts = Array.isArray(contentRecord.parts) ? contentRecord.parts : [];
    const contentText =
      typeof contentRecord.text === "string"
        ? contentRecord.text
        : typeof parts[0] === "string"
          ? parts[0]
          : "";
    const heredocContent = extractHeredocContent(contentText, filename);
    if (heredocContent !== null) {
      return heredocContent;
    }
    if (contentRecord.content_type === "execution_output") {
      const outputContent = extractToolOutputContent(contentText, filename);
      if (outputContent !== null) {
        return outputContent;
      }
    }
    const aggregate = (
      message.metadata as { aggregate_result?: { final_expression_output?: unknown } }
    )?.aggregate_result;
    if (typeof aggregate?.final_expression_output === "string") {
      const outputContent = extractToolOutputContent(aggregate.final_expression_output, filename);
      if (outputContent !== null) {
        return outputContent;
      }
    }
  }
  return null;
}

async function fetchConversationSnapshot(
  client: ChromeClient,
  options: AssistantDownloadCaptureOptions,
): Promise<unknown | null> {
  const conversationId = options.conversationId?.trim();
  if (!conversationId) {
    return null;
  }
  const projectId = projectIdFromUrl(options.tabUrl);
  const result = await client.Runtime.evaluate({
    expression: `(async () => {
      const session = await fetch('/api/auth/session', { credentials: 'include' })
        .then((response) => response.ok ? response.json() : null)
        .catch(() => null);
      const headers = { 'OAI-Language': 'en-US' };
      if (session?.accessToken) {
        headers.Authorization = 'Bearer ' + session.accessToken;
      }
      const projectId = ${JSON.stringify(projectId)};
      if (projectId) {
        headers['chatgpt-project-id'] = projectId;
      }
      const response = await fetch(${JSON.stringify(`/backend-api/conversation/${conversationId}`)}, {
        credentials: 'include',
        headers,
      });
      return {
        status: response.status,
        text: await response.text(),
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const payload = (result.result?.value ?? null) as { status?: number; text?: string } | null;
  if (payload?.status !== 200 || !payload.text) {
    options.logger?.sessionLog?.(
      `[browser-downloads] sandbox conversation fetch failed: HTTP ${payload?.status ?? "unknown"}`,
    );
    return null;
  }
  try {
    return JSON.parse(payload.text);
  } catch {
    options.logger?.sessionLog?.(
      "[browser-downloads] sandbox conversation fetch returned JSON that could not be parsed",
    );
    return null;
  }
}

async function captureSandboxDownloadsFromConversation(
  client: ChromeClient,
  options: AssistantDownloadCaptureOptions,
): Promise<BrowserDownloadedFile[]> {
  if (!options.downloadsDir) {
    return [];
  }
  const names = extractSandboxDownloadNames(options.assistantMarkdown);
  if (names.length === 0) {
    return [];
  }
  const conversation = await fetchConversationSnapshot(client, options);
  if (!conversation) {
    return [];
  }
  await mkdir(options.downloadsDir, { recursive: true });
  const downloads: BrowserDownloadedFile[] = [];
  for (const filename of names) {
    const content = extractSandboxFileContent(conversation, filename);
    if (content === null) {
      options.logger?.sessionLog?.(
        `[browser-downloads] sandbox content not found in conversation for ${filename}`,
      );
      continue;
    }
    const targetPath = await resolveUniqueDownloadPath(options.downloadsDir, filename);
    await writeFile(targetPath, content);
    const fileStat = await stat(targetPath);
    downloads.push({
      path: targetPath,
      suggestedFilename: filename,
      sizeBytes: fileStat.size,
    });
  }
  if (downloads.length > 0) {
    options.logger?.sessionLog?.(
      `[browser-downloads] recovered ${downloads.length} sandbox file(s) from conversation metadata`,
    );
  }
  return downloads;
}

async function waitForBrowserDownload(
  browserClient: EventedChromeClient,
  downloadsDir: string,
  beforeFiles: Set<string>,
  trigger: () => Promise<boolean>,
  timeoutMs: number = DOWNLOAD_EVENT_TIMEOUT_MS,
): Promise<BrowserDownloadedFile | null> {
  let trackedGuid: string | undefined;
  let willBegin: DownloadEventInfo | undefined;
  let settled = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  return await new Promise<BrowserDownloadedFile | null>((resolve) => {
    const finish = async (progress?: DownloadProgressInfo | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      removeEventListener(browserClient, "Browser.downloadWillBegin", onWillBegin);
      removeEventListener(browserClient, "Browser.downloadProgress", onProgress);
      const targetPath = await resolveDownloadedFilePath(
        downloadsDir,
        beforeFiles,
        willBegin?.suggestedFilename,
        progress?.filePath,
      );
      if (!targetPath) {
        resolve(null);
        return;
      }
      try {
        const fileStat = await stat(targetPath);
        resolve({
          path: targetPath,
          suggestedFilename: sanitizeSuggestedFilename(willBegin?.suggestedFilename),
          sizeBytes: fileStat.size,
        });
      } catch {
        resolve(null);
      }
    };

    const onWillBegin = (event: unknown) => {
      if (trackedGuid) {
        return;
      }
      const payload = event as DownloadEventInfo;
      trackedGuid = payload.guid;
      willBegin = payload;
    };
    const onProgress = (event: unknown) => {
      const payload = event as DownloadProgressInfo;
      if (!trackedGuid || payload.guid !== trackedGuid) {
        return;
      }
      if (payload.state === "completed" || payload.state === "canceled") {
        void finish(payload);
      }
    };

    browserClient.on("Browser.downloadWillBegin", onWillBegin);
    browserClient.on("Browser.downloadProgress", onProgress);
    timeoutId = setTimeout(() => {
      void finish(null);
    }, timeoutMs);

    void trigger()
      .then((clicked) => {
        if (!clicked) {
          void finish(null);
        }
      })
      .catch(() => {
        void finish(null);
      });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryTargetDownloadCandidate(params: {
  browserClient: EventedChromeClient;
  targetClient: ChromeClient;
  options: AssistantDownloadCaptureOptions;
  candidate: DownloadCandidateDescriptor;
  mode: CandidateCollectionMode;
  timeoutMs?: number;
  label: string;
}): Promise<BrowserDownloadedFile | null> {
  const { browserClient, targetClient, options, candidate, mode, timeoutMs, label } = params;
  if (!options.downloadsDir) {
    return null;
  }
  const beforeFiles = new Set(await readdir(options.downloadsDir).catch(() => []));
  options.logger?.sessionLog?.(
    `[browser-downloads] raw CDP trying ${label} candidate ${candidate.index} (${mode}) score=${candidate.score}`,
  );
  const download = await waitForBrowserDownload(
    browserClient,
    options.downloadsDir,
    beforeFiles,
    async () => {
      const clickResult = await clickTargetDownloadCandidate(
        targetClient,
        options.meta,
        candidate.index,
        mode,
      );
      if (!clickResult.clicked) {
        options.logger?.sessionLog?.(
          `[browser-downloads] raw CDP click failed for ${label} candidate ${candidate.index} (${mode}): ${clickResult.reason ?? "unknown"}`,
        );
      }
      return clickResult.clicked;
    },
    timeoutMs,
  );
  if (!download) {
    options.logger?.sessionLog?.(
      `[browser-downloads] raw CDP ${label} candidate ${candidate.index} (${mode}) did not download`,
    );
  }
  return download;
}

async function tryScopedThenPreviewDownloadCandidate(params: {
  browserClient: EventedChromeClient;
  targetClient: ChromeClient;
  options: AssistantDownloadCaptureOptions;
  candidate: DownloadCandidateDescriptor;
}): Promise<BrowserDownloadedFile | null> {
  const { browserClient, targetClient, options, candidate } = params;
  if (!options.downloadsDir) {
    return null;
  }
  const beforeFiles = new Set(await readdir(options.downloadsDir).catch(() => []));
  options.logger?.sessionLog?.(
    `[browser-downloads] raw CDP trying scoped candidate ${candidate.index} (scope) score=${candidate.score}`,
  );
  const download = await waitForBrowserDownload(
    browserClient,
    options.downloadsDir,
    beforeFiles,
    async () => {
      const clickResult = await clickTargetDownloadCandidate(
        targetClient,
        options.meta,
        candidate.index,
        "scope",
      );
      if (!clickResult.clicked) {
        options.logger?.sessionLog?.(
          `[browser-downloads] raw CDP click failed for scoped candidate ${candidate.index} (scope): ${clickResult.reason ?? "unknown"}`,
        );
        return false;
      }
      await sleep(DOWNLOAD_PREVIEW_SETTLE_MS);
      const documentCandidates = await collectAndLogTargetDownloadCandidates(
        targetClient,
        options,
        "document",
      );
      let clickedPreview = false;
      for (const documentCandidate of documentCandidates) {
        options.logger?.sessionLog?.(
          `[browser-downloads] raw CDP trying preview candidate ${documentCandidate.index} (document) score=${documentCandidate.score}`,
        );
        const previewClick = await clickTargetDownloadCandidate(
          targetClient,
          options.meta,
          documentCandidate.index,
          "document",
        );
        if (!previewClick.clicked) {
          options.logger?.sessionLog?.(
            `[browser-downloads] raw CDP click failed for preview candidate ${documentCandidate.index} (document): ${previewClick.reason ?? "unknown"}`,
          );
          continue;
        }
        clickedPreview = true;
        break;
      }
      return clickedPreview || documentCandidates.length === 0;
    },
  );
  if (!download) {
    options.logger?.sessionLog?.(
      `[browser-downloads] raw CDP scoped candidate ${candidate.index} (scope) and preview fallback did not download`,
    );
  }
  return download;
}

async function collectAndLogTargetDownloadCandidates(
  client: ChromeClient,
  options: AssistantDownloadCaptureOptions,
  mode: CandidateCollectionMode,
): Promise<DownloadCandidateDescriptor[]> {
  const { candidates, source, rawCount, rawSample } = await collectTargetDownloadCandidates(
    client,
    options.meta,
    mode,
  );
  options.logger?.sessionLog?.(
    `[browser-downloads] raw CDP ${mode} candidates found: ${candidates.length} (${source}); raw controls=${rawCount}; sample=${JSON.stringify(rawSample)}`,
  );
  return candidates;
}

async function captureAssistantDownloadsViaCdp(
  options: AssistantDownloadCaptureOptions,
  target: TargetInfoLite,
): Promise<BrowserDownloadedFile[]> {
  const targetId = targetIdentity(target);
  if (!targetId || !options.chromeHost || !options.chromePort || !options.downloadsDir) {
    return [];
  }
  const browserClient = (await CDP({
    host: options.chromeHost,
    port: options.chromePort,
  })) as EventedChromeClient;
  const providedTargetClient = options.targetClient;
  const targetClient =
    providedTargetClient ??
    ((await CDP({
      host: options.chromeHost,
      port: options.chromePort,
      target: targetId,
    })) as ChromeClient);
  try {
    await mkdir(options.downloadsDir, { recursive: true });
    await browserClient.Browser.setDownloadBehavior({
      behavior: "allow",
      downloadPath: options.downloadsDir,
      eventsEnabled: true,
    });
    await targetClient.Runtime.enable().catch(() => undefined);
    const candidates = await collectAndLogTargetDownloadCandidates(targetClient, options, "scope");
    const downloads: BrowserDownloadedFile[] = [];
    for (const candidate of candidates) {
      const download = await tryScopedThenPreviewDownloadCandidate({
        browserClient,
        targetClient,
        options,
        candidate,
      });
      if (download) {
        downloads.push(download);
      }
    }
    if (downloads.length === 0) {
      downloads.push(...(await captureSandboxDownloadsFromConversation(targetClient, options)));
    }
    if (candidates.length === 0) {
      const documentCandidates = await collectAndLogTargetDownloadCandidates(
        targetClient,
        options,
        "document",
      );
      for (const candidate of documentCandidates) {
        const download = await tryTargetDownloadCandidate({
          browserClient,
          targetClient,
          options,
          candidate,
          mode: "document",
          label: "document",
        });
        if (download) {
          downloads.push(download);
        }
      }
    }
    return downloads;
  } finally {
    if (!providedTargetClient) {
      await targetClient.close().catch(() => undefined);
    }
    await browserClient.close().catch(() => undefined);
  }
}

async function listBrowserTargets(
  browser: Browser,
  logger?: BrowserLogger,
): Promise<TargetInfoLite[]> {
  try {
    const session = await browser.newBrowserCDPSession();
    try {
      const result = (await session.send("Target.getTargets")) as unknown as {
        targetInfos?: TargetInfoLite[];
      };
      return Array.isArray(result.targetInfos) ? result.targetInfos : [];
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch (error) {
    logger?.sessionLog?.(
      `[browser-downloads] failed to list browser targets: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

async function resolvePageTargetId(page: Page): Promise<string | undefined> {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      const result = (await session.send("Target.getTargetInfo")) as unknown as {
        targetInfo?: TargetInfoLite;
      };
      return targetIdentity(result.targetInfo);
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch {
    return undefined;
  }
}

async function collectPageSelectionCandidates(pages: Page[]): Promise<PageSelectionCandidate[]> {
  return await Promise.all(
    pages.map(async (page, index) => {
      const normalizedUrl = normalizeSupervisorPageUrl(page.url());
      return {
        index,
        normalizedUrl,
        conversationId: extractConversationIdFromUrl(normalizedUrl ?? page.url()),
        targetId: await resolvePageTargetId(page),
      };
    }),
  );
}

function resolvePageSelection(
  candidates: PageSelectionCandidate[],
  runtime: Pick<AssistantDownloadCaptureOptions, "chromeTargetId" | "tabUrl" | "conversationId">,
  targets: TargetInfoLite[],
): PageSelectionResult | null {
  if (candidates.length === 0) {
    return null;
  }

  const runtimeTabUrl = normalizeSupervisorPageUrl(runtime.tabUrl);
  const runtimeConversationId =
    runtime.conversationId ?? extractConversationIdFromUrl(runtimeTabUrl ?? runtime.tabUrl ?? "");
  const hasRuntimeIdentity = Boolean(
    runtime.chromeTargetId || runtimeTabUrl || runtimeConversationId,
  );

  if (runtime.chromeTargetId) {
    const byTargetId = candidates.filter(
      (candidate) => candidate.targetId === runtime.chromeTargetId,
    );
    if (byTargetId.length === 1) {
      return { index: byTargetId[0].index, reason: "runtime-target-id" };
    }
    if (byTargetId.length > 1) {
      return null;
    }
  }

  if (runtimeTabUrl) {
    const exactUrlMatches = candidates.filter(
      (candidate) => candidate.normalizedUrl === runtimeTabUrl,
    );
    if (exactUrlMatches.length === 1) {
      return { index: exactUrlMatches[0].index, reason: "runtime-tab-url" };
    }
    if (exactUrlMatches.length > 1) {
      return null;
    }
  }

  const selectedTarget = pickTarget(
    targets,
    {
      chromeTargetId: runtime.chromeTargetId,
      tabUrl: runtimeTabUrl,
      conversationId: runtimeConversationId,
    },
    { requireMatch: hasRuntimeIdentity },
  );
  const selectedTargetId = targetIdentity(selectedTarget);
  if (selectedTargetId) {
    const bySelectedTargetId = candidates.filter(
      (candidate) => candidate.targetId === selectedTargetId,
    );
    if (bySelectedTargetId.length === 1) {
      return { index: bySelectedTargetId[0].index, reason: "browser-target-id" };
    }
    if (bySelectedTargetId.length > 1) {
      return null;
    }
  }

  const selectedTargetUrl = normalizeSupervisorPageUrl(selectedTarget?.url);
  if (selectedTargetUrl) {
    const bySelectedTargetUrl = candidates.filter(
      (candidate) => candidate.normalizedUrl === selectedTargetUrl,
    );
    if (bySelectedTargetUrl.length === 1) {
      return { index: bySelectedTargetUrl[0].index, reason: "browser-target-url" };
    }
    if (bySelectedTargetUrl.length > 1) {
      return null;
    }
  }

  if (runtimeConversationId) {
    const byConversationId = candidates.filter(
      (candidate) => candidate.conversationId === runtimeConversationId,
    );
    if (byConversationId.length === 1) {
      return { index: byConversationId[0].index, reason: "runtime-conversation-id" };
    }
    if (byConversationId.length > 1) {
      return null;
    }
  }

  if (!hasRuntimeIdentity && candidates.length === 1) {
    return { index: candidates[0].index, reason: "only-page" };
  }

  return null;
}

export async function captureAssistantDownloads(
  options: AssistantDownloadCaptureOptions,
): Promise<BrowserDownloadedFile[]> {
  const logger = options.logger;
  if (!options.downloadsDir) {
    return [];
  }
  if (!isLocalEndpoint(options.browserWSEndpoint, options.chromeHost)) {
    logger?.sessionLog?.(
      "[browser-downloads] skipped: download capture only supports same-host CDP sessions",
    );
    return [];
  }
  if (options.chromeTargetId) {
    const runtimeTarget: TargetInfoLite = {
      targetId: options.chromeTargetId,
      type: "page",
      url: options.tabUrl,
    };
    logger?.sessionLog?.(
      `[browser-downloads] trying runtime target via raw CDP before Playwright attach: ${options.chromeTargetId}`,
    );
    const rawDownloads = await captureAssistantDownloadsViaCdp(options, runtimeTarget).catch(
      (error) => {
        logger?.sessionLog?.(
          `[browser-downloads] raw CDP runtime target capture failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return [];
      },
    );
    if (rawDownloads.length > 0) {
      return rawDownloads;
    }
    if (options.targetClient) {
      const sandboxDownloads = await captureSandboxDownloadsFromConversation(
        options.targetClient,
        options,
      ).catch((error) => {
        logger?.sessionLog?.(
          `[browser-downloads] sandbox metadata capture failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return [];
      });
      if (sandboxDownloads.length > 0) {
        return sandboxDownloads;
      }
    }
  }
  const bridge = await connectPlaywrightSupervisor({
    browserWSEndpoint: options.browserWSEndpoint,
    host: options.chromeHost,
    port: options.chromePort,
    timeoutMs: 30_000,
  });
  try {
    const pages = bridge.browser.contexts().flatMap((context) => context.pages());
    const [browserTargets, pageCandidates] = await Promise.all([
      listBrowserTargets(bridge.browser, logger),
      collectPageSelectionCandidates(pages),
    ]);
    const runtimeConversationId =
      options.conversationId ?? extractConversationIdFromUrl(options.tabUrl ?? "");
    const directDownloadTarget = pickDirectDownloadTarget(browserTargets, {
      chromeTargetId: options.chromeTargetId,
      tabUrl: options.tabUrl,
      conversationId: runtimeConversationId,
    });
    if (directDownloadTarget && directDownloadTarget.type && directDownloadTarget.type !== "page") {
      logger?.sessionLog?.(
        `[browser-downloads] falling back to raw CDP capture for ${directDownloadTarget.type}:${targetIdentity(directDownloadTarget) ?? "unknown"}:${directDownloadTarget.url ?? "about:blank"}`,
      );
      const rawDownloads = await captureAssistantDownloadsViaCdp(options, directDownloadTarget);
      if (rawDownloads.length > 0) {
        return rawDownloads;
      }
    }
    const selection = resolvePageSelection(
      pageCandidates,
      {
        chromeTargetId: options.chromeTargetId,
        tabUrl: options.tabUrl,
        conversationId: options.conversationId,
      },
      browserTargets,
    );
    if (!selection && directDownloadTarget) {
      const rawDownloads = await captureAssistantDownloadsViaCdp(options, directDownloadTarget);
      if (rawDownloads.length > 0) {
        return rawDownloads;
      }
    }
    if (!selection) {
      logger?.sessionLog?.(
        `[browser-downloads] skipped: unable to identify the active ChatGPT page (runtime target=${options.chromeTargetId ?? "unknown"} tab=${options.tabUrl ?? "unknown"} pages=${summarizePageCandidates(pageCandidates)} targets=${summarizeTargets(browserTargets)})`,
      );
      return [];
    }
    const page = pages[selection.index];
    logger?.sessionLog?.(
      `[browser-downloads] selected page via ${selection.reason}: ${summarizePageCandidates([pageCandidates[selection.index]])}`,
    );
    const scope = await resolveAssistantTurnScope(page, options.meta);
    if (!scope) {
      logger?.sessionLog?.(
        "[browser-downloads] skipped: unable to identify the latest assistant turn",
      );
      return [];
    }
    const candidates = await collectDownloadCandidates(scope);
    if (candidates.length === 0) {
      return [];
    }
    await mkdir(options.downloadsDir, { recursive: true });
    const actionable = scope.locator(DOWNLOAD_CANDIDATE_SELECTOR);
    const downloads: BrowserDownloadedFile[] = [];
    for (const candidate of candidates) {
      try {
        const downloadPromise = page.waitForEvent("download", {
          timeout: DOWNLOAD_EVENT_TIMEOUT_MS,
        });
        await actionable.nth(candidate.index).click({ timeout: CLICK_TIMEOUT_MS });
        const download = await downloadPromise;
        const suggestedFilename = sanitizeSuggestedFilename(download.suggestedFilename());
        const targetPath = await resolveUniqueDownloadPath(options.downloadsDir, suggestedFilename);
        await download.saveAs(targetPath);
        const fileStat = await stat(targetPath);
        downloads.push({
          path: targetPath,
          suggestedFilename,
          sizeBytes: fileStat.size,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger?.sessionLog?.(
          `[browser-downloads] candidate ${candidate.index} did not download: ${message}`,
        );
      }
    }
    return downloads;
  } finally {
    await bridge.close();
  }
}

export const __test__ = {
  candidateFingerprint,
  extractSandboxDownloadNames,
  extractSandboxFileContent,
  resolvePageSelection,
  sanitizeSuggestedFilename,
  scoreDownloadCandidate,
};
