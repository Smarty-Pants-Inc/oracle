import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { sessionStore } from "../sessionStore.js";
import { sanitizeSessionSlugBase } from "../sessionManager.js";
import { performSessionRun } from "./sessionRunner.js";
import { getCliVersion } from "../version.js";
import { loadUserConfig } from "../config.js";
import { mapConsultToRunOptions, ensureBrowserAvailable } from "../mcp/utils.js";
import { buildConsultBrowserConfig } from "../mcp/tools/consult.js";
import { normalizeBrowserModelStrategy } from "../browser/modelStrategy.js";
import type { BrowserModelStrategy } from "../browser/types.js";
import { CHATGPT_URL } from "../browser/constants.js";
import { isSupervisorScopedChatgptUrl, normalizeChatgptUrl } from "../browser/utils.js";
import { resolveRemoteServiceConfig } from "../remote/remoteServiceConfig.js";
import { createRemoteBrowserExecutor } from "../remote/client.js";
import type { BrowserSessionRunnerDeps } from "../browser/sessionRunner.js";
import type {
  BrowserSessionConfig,
  SessionMetadata,
  SupervisorThreadBindingMetadata,
} from "../sessionStore.js";
import type { UserConfig } from "../config.js";
import type { ThinkingTimeLevel } from "../oracle.js";
import { asOracleUserError, formatElapsed } from "../oracle.js";

const SUPERVISOR_BROWSER_THROTTLE_FILE = path.join(
  os.homedir(),
  ".oracle",
  "supervisor-browser-throttle.json",
);
const SUPERVISOR_BROWSER_THROTTLE_FILE_ENV = "ORACLE_SUPERVISOR_THROTTLE_FILE";
const SUPERVISOR_BROWSER_LEASE_OWNER_ID_ENV = "ORACLE_SUPERVISOR_LEASE_OWNER_ID";
const SUPERVISOR_BROWSER_PROFILE_DIR = path.join(os.homedir(), ".oracle", "browser-profile-hidden");
const SUPERVISOR_BROWSER_MIN_GAP_MS = 30_000;
const SUPERVISOR_BROWSER_WINDOW_MS = 30 * 60_000;
const SUPERVISOR_BROWSER_PRO_MAX_REQUESTS = 6;
const SUPERVISOR_BROWSER_DEFAULT_MAX_REQUESTS = 6;
const SUPERVISOR_BROWSER_RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;
const SUPERVISOR_BROWSER_REUSE_WAIT_MS = 30_000;
const SUPERVISOR_BROWSER_ASSISTANT_RECHECK_DELAY_MS = 30_000;
const SUPERVISOR_BROWSER_ASSISTANT_RECHECK_TIMEOUT_MS = 300_000;
const SUPERVISOR_BROWSER_AUTO_REATTACH_DELAY_MS = 30_000;
const SUPERVISOR_BROWSER_AUTO_REATTACH_INTERVAL_MS = 30_000;
const SUPERVISOR_BROWSER_AUTO_REATTACH_TIMEOUT_MS = 300_000;
const SUPERVISOR_BROWSER_THROTTLE_LOCK_TIMEOUT_MS = 10_000;
const SUPERVISOR_BROWSER_THROTTLE_LOCK_POLL_MS = 100;
const SUPERVISOR_BROWSER_LEASE_TTL_MS = 15 * 60_000;
const SUPERVISOR_BROWSER_LEASE_HEARTBEAT_MS = Math.min(
  60_000,
  Math.max(30_000, Math.trunc(SUPERVISOR_BROWSER_LEASE_TTL_MS / 3)),
);
const SUPERVISOR_BROWSER_ACTIVE_LEASE_RECHECK_MS = 5_000;
const SUPERVISOR_BROWSER_RUNTIME_ATTACH_RECHECK_MIN_MS = 250;
const SUPERVISOR_PROMPT_COMPLETION_POLL_MS = 500;
const SUPERVISOR_PROMPT_RUN_SETTLE_GRACE_MS = 10_000;
const SUPERVISOR_CHATGPT_URL_ENV = "ORACLE_SUPERVISOR_CHATGPT_URL";

interface SupervisorBrowserThrottleLease {
  ownerId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  expiresAt: string;
  processStartMarker?: string;
}

interface SupervisorBrowserThrottleEntry {
  requestStartedAt?: string[];
  cooldownUntil?: string;
  activeLease?: SupervisorBrowserThrottleLease | null;
}

interface SupervisorBrowserThrottleState {
  profiles?: Record<string, SupervisorBrowserThrottleEntry>;
}

interface SupervisorBrowserThrottleDecision {
  delayMs: number;
  reason: "active-lease" | "min-gap" | "window-budget" | "rate-limit-cooldown" | null;
}

interface SupervisorBrowserThrottleLockRecord {
  pid: number;
  lockId: string;
  createdAt: string;
  expiresAt: string;
  processStartMarker?: string;
}

interface SupervisorPromptCompletionSnapshot {
  sessionStatus: string | undefined;
  incompleteReason: string | null | undefined;
  output: string;
}

type SupervisorPromptRunOutcome =
  | { kind: "run-finished" }
  | { kind: "run-failed"; error: unknown }
  | { kind: "run-still-pending"; snapshot: SupervisorPromptCompletionSnapshot }
  | { kind: "session-completed"; snapshot: SupervisorPromptCompletionSnapshot }
  | { kind: "session-terminal"; snapshot: SupervisorPromptCompletionSnapshot };

const SUPERVISOR_PROMPT_RUN_STILL_PENDING = Symbol("supervisor-prompt-run-still-pending");

export interface SupervisorPromptRequest {
  prompt: string;
  sessionSlug: string;
  model?: string;
  browserModelStrategy?: string;
  browserModelLabel?: string;
  browserThinkingTime?: ThinkingTimeLevel;
  followupSession?: string;
  files?: string[];
  cwd?: string;
}

export function buildSupervisorBrowserConfig({
  userConfig,
  env,
  runModel,
  inputModel,
  supervisorChatgptUrl,
  browserModelLabel,
  browserModelStrategy,
  browserThinkingTime,
  supervisorThrottleScope,
  defaultManualLoginCookieSync,
  useDedicatedHiddenProfile = true,
}: {
  userConfig: UserConfig;
  env: Record<string, string | undefined>;
  runModel: string;
  inputModel: string;
  supervisorChatgptUrl?: string;
  browserModelLabel?: string;
  browserModelStrategy?: BrowserModelStrategy;
  browserThinkingTime?: ThinkingTimeLevel;
  supervisorThrottleScope?: string;
  defaultManualLoginCookieSync?: boolean;
  useDedicatedHiddenProfile?: boolean;
}): BrowserSessionConfig {
  const browserConfig = buildConsultBrowserConfig({
    userConfig,
    env,
    runModel,
    inputModel,
    browserModelLabel,
    browserModelStrategy,
    browserThinkingTime,
    browserKeepBrowser: true,
  });
  const manualLoginCookieSync =
    userConfig.browser?.manualLoginCookieSync ??
    defaultManualLoginCookieSync ??
    process.platform === "darwin";
  browserConfig.manualLoginProfileDir = useDedicatedHiddenProfile
    ? SUPERVISOR_BROWSER_PROFILE_DIR
    : null;
  browserConfig.launcher = "chrome";
  browserConfig.keepBrowser = true;
  browserConfig.reuseChromeWaitMs ??= SUPERVISOR_BROWSER_REUSE_WAIT_MS;
  browserConfig.assistantRecheckDelayMs ??= SUPERVISOR_BROWSER_ASSISTANT_RECHECK_DELAY_MS;
  browserConfig.assistantRecheckTimeoutMs ??= SUPERVISOR_BROWSER_ASSISTANT_RECHECK_TIMEOUT_MS;
  browserConfig.autoReattachDelayMs ??= SUPERVISOR_BROWSER_AUTO_REATTACH_DELAY_MS;
  browserConfig.autoReattachIntervalMs ??= SUPERVISOR_BROWSER_AUTO_REATTACH_INTERVAL_MS;
  browserConfig.autoReattachTimeoutMs ??= SUPERVISOR_BROWSER_AUTO_REATTACH_TIMEOUT_MS;

  browserConfig.manualLogin = true;
  browserConfig.manualLoginCookieSync = manualLoginCookieSync;
  browserConfig.cookieSync = manualLoginCookieSync;
  browserConfig.attachRunning = false;
  browserConfig.remoteChrome = null;
  browserConfig.remoteChromeBrowserWSEndpoint = null;
  browserConfig.remoteChromeProfileRoot = null;
  browserConfig.supervisorThrottleScope = supervisorThrottleScope ?? null;
  if (supervisorChatgptUrl) {
    const normalizedSupervisorUrl = normalizeChatgptUrl(supervisorChatgptUrl, CHATGPT_URL);
    browserConfig.chatgptUrl = normalizedSupervisorUrl;
    browserConfig.url = normalizedSupervisorUrl;
  }
  if (process.platform === "darwin") {
    browserConfig.hideWindow = true;
  }
  return browserConfig;
}

function parseSupervisorSessionTimestamp(meta: SessionMetadata): number {
  const candidate = meta.startedAt ?? meta.completedAt ?? meta.createdAt;
  const parsed = Date.parse(candidate ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveConfiguredSupervisorChatgptUrl(
  userConfig: UserConfig,
  env: Record<string, string | undefined>,
): string | null {
  const explicitSupervisorUrl =
    env[SUPERVISOR_CHATGPT_URL_ENV]?.trim() ||
    userConfig.browser?.supervisorChatgptUrl?.trim() ||
    null;
  if (explicitSupervisorUrl) {
    if (!isSupervisorScopedChatgptUrl(explicitSupervisorUrl)) {
      throw new Error(
        "Supervisor browser requires ORACLE_SUPERVISOR_CHATGPT_URL/browser.supervisorChatgptUrl to be the ChatGPT root or a /g/.../project URL.",
      );
    }
    return normalizeChatgptUrl(explicitSupervisorUrl, CHATGPT_URL);
  }
  const configuredBrowserUrl =
    userConfig.browser?.chatgptUrl?.trim() || userConfig.browser?.url?.trim() || null;
  if (configuredBrowserUrl && isSupervisorScopedChatgptUrl(configuredBrowserUrl)) {
    return normalizeChatgptUrl(configuredBrowserUrl, CHATGPT_URL);
  }
  return normalizeChatgptUrl(CHATGPT_URL, CHATGPT_URL);
}

function findRecentSupervisorProjectUrl(
  metas: SessionMetadata[],
  profileDir = SUPERVISOR_BROWSER_PROFILE_DIR,
): string | null {
  const normalizedProfileDir = path.resolve(profileDir);
  for (const meta of [...metas].sort(
    (left, right) => parseSupervisorSessionTimestamp(right) - parseSupervisorSessionTimestamp(left),
  )) {
    const config = meta.browser?.config;
    if (!config) {
      continue;
    }
    const configuredProfileDir = config?.manualLoginProfileDir?.trim();
    if (!configuredProfileDir || path.resolve(configuredProfileDir) !== normalizedProfileDir) {
      continue;
    }
    const candidateUrl = config.chatgptUrl ?? config.url ?? null;
    if (isSupervisorScopedChatgptUrl(candidateUrl)) {
      return normalizeChatgptUrl(candidateUrl, CHATGPT_URL);
    }
  }
  return null;
}

async function resolveSupervisorChatgptUrl({
  userConfig,
  env,
}: {
  userConfig: UserConfig;
  env: Record<string, string | undefined>;
}): Promise<string> {
  const configured = resolveConfiguredSupervisorChatgptUrl(userConfig, env);
  if (configured) {
    return configured;
  }
  return normalizeChatgptUrl(CHATGPT_URL, CHATGPT_URL);
}

function normalizeSupervisorText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sessionIdMatchesRequestedSlug(sessionId: string, sessionSlug: string): boolean {
  const trimmedSlug = sanitizeSessionSlugBase(sessionSlug);
  if (!trimmedSlug) {
    return false;
  }
  return new RegExp(`^${escapeRegExp(trimmedSlug)}(?:-\\d+)?$`).test(sessionId);
}

function normalizeSupervisorCwd(value: string | null | undefined): string | null {
  const normalized = normalizeSupervisorText(value);
  return normalized ? path.resolve(normalized) : null;
}

function normalizeSupervisorFiles(
  values: string[] | null | undefined,
  cwd: string | null | undefined,
): string[] {
  const baseDir = normalizeSupervisorCwd(cwd) ?? process.cwd();
  return (values ?? [])
    .map((value) => normalizeSupervisorText(value))
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(baseDir, value))
    .sort();
}

function sessionMatchesSupervisorPromptRequest(
  meta: SessionMetadata,
  request: SupervisorPromptRequest,
  requestedModel: string,
  browserConfig: BrowserSessionConfig,
  expectedSupervisorThread?: SupervisorThreadBindingMetadata | null,
): boolean {
  if ((meta.mode ?? meta.options.mode) !== "browser") {
    return false;
  }
  if (!sessionIdMatchesRequestedSlug(meta.id, request.sessionSlug)) {
    return false;
  }
  if (normalizeSupervisorText(meta.options.prompt) !== normalizeSupervisorText(request.prompt)) {
    return false;
  }
  if (
    normalizeSupervisorText(meta.options.followupSessionId) !==
    normalizeSupervisorText(request.followupSession)
  ) {
    return false;
  }
  const metaModel = normalizeSupervisorText(
    meta.options.effectiveModelId ?? meta.options.model ?? meta.model,
  );
  if (metaModel && metaModel !== normalizeSupervisorText(requestedModel)) {
    return false;
  }
  const requestedUrl = normalizeChatgptUrl(
    browserConfig.chatgptUrl ?? browserConfig.url ?? CHATGPT_URL,
    CHATGPT_URL,
  );
  const metaUrl = normalizeChatgptUrl(
    meta.browser?.config?.chatgptUrl ?? meta.browser?.config?.url ?? CHATGPT_URL,
    CHATGPT_URL,
  );
  if (requestedUrl !== metaUrl) {
    return false;
  }
  const requestedThinkingTime = normalizeSupervisorText(browserConfig.thinkingTime);
  const metaThinkingTime = normalizeSupervisorText(
    meta.browser?.config?.thinkingTime ?? meta.options.browserConfig?.thinkingTime,
  );
  if (requestedThinkingTime !== metaThinkingTime) {
    return false;
  }
  const requestedThrottleScope = normalizeSupervisorText(browserConfig.supervisorThrottleScope);
  const metaThrottleScope = normalizeSupervisorText(
    meta.browser?.config?.supervisorThrottleScope ??
      meta.options.browserConfig?.supervisorThrottleScope,
  );
  if (requestedThrottleScope !== metaThrottleScope) {
    return false;
  }
  const requestedProfileDir = normalizeSupervisorText(browserConfig.manualLoginProfileDir);
  const metaProfileDir = normalizeSupervisorText(meta.browser?.config?.manualLoginProfileDir);
  if (
    (requestedProfileDir ? path.resolve(requestedProfileDir) : null) !==
    (metaProfileDir ? path.resolve(metaProfileDir) : null)
  ) {
    return false;
  }
  if (normalizeSupervisorCwd(meta.cwd) !== normalizeSupervisorCwd(request.cwd)) {
    return false;
  }
  const metaFiles = normalizeSupervisorFiles(
    Array.isArray(meta.options.file) ? meta.options.file : [],
    meta.cwd,
  );
  const requestFiles = normalizeSupervisorFiles(request.files, request.cwd);
  if (
    metaFiles.length !== requestFiles.length ||
    metaFiles.some((value, index) => value !== requestFiles[index])
  ) {
    return false;
  }
  if (expectedSupervisorThread) {
    const candidateConversationId = meta.supervisorThread?.conversationId?.trim();
    if (candidateConversationId !== expectedSupervisorThread.conversationId) {
      return false;
    }
  }
  return true;
}

function pickReusableSupervisorPromptSession(
  metas: SessionMetadata[],
  request: SupervisorPromptRequest,
  requestedModel: string,
  browserConfig: BrowserSessionConfig,
  expectedSupervisorThread?: SupervisorThreadBindingMetadata | null,
): SessionMetadata | null {
  const matches = metas
    .filter((meta) =>
      sessionMatchesSupervisorPromptRequest(
        meta,
        request,
        requestedModel,
        browserConfig,
        expectedSupervisorThread,
      ),
    )
    .sort(
      (left, right) =>
        parseSupervisorSessionTimestamp(right) - parseSupervisorSessionTimestamp(left),
    );
  return matches[0] ?? null;
}

function extractSupervisorPromptOutputFromLog(logText: string): string {
  const trimmed = logText.trimEnd();
  if (!trimmed) {
    return "";
  }
  const answerIndex = trimmed.lastIndexOf("Answer:");
  if (answerIndex === -1) {
    return trimmed;
  }
  return trimmed
    .slice(answerIndex + "Answer:".length)
    .replace(/^\s+/, "")
    .trimEnd();
}

async function readReusableSupervisorPromptOutput(
  meta: SessionMetadata,
  readLog: (sessionId: string) => Promise<string> = (sessionId) => sessionStore.readLog(sessionId),
): Promise<string> {
  const sessionStatus = meta.response?.status ?? meta.status;
  const assistantOutput = String(meta.response?.assistantOutput ?? "").trimEnd();
  if (assistantOutput) {
    return assistantOutput;
  }
  if (sessionStatus !== "completed") {
    return "";
  }
  const logOutput = await readLog(meta.id).catch(() => "");
  return extractSupervisorPromptOutputFromLog(logOutput);
}

function normalizeSupervisorThreadBinding(
  value: SessionMetadata["supervisorThread"] | null | undefined,
): SupervisorThreadBindingMetadata | null {
  const conversationId = value?.conversationId?.trim();
  if (!conversationId) {
    return null;
  }
  return {
    conversationId,
    url: value?.url?.trim() || undefined,
    projectUrl: value?.projectUrl?.trim() || undefined,
    verifiedAt: value?.verifiedAt?.trim() || new Date(0).toISOString(),
  };
}

async function resolveSupervisorThreadBinding(
  sessionId: string | undefined,
): Promise<SupervisorThreadBindingMetadata | null> {
  let current = sessionId?.trim();
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const meta = await sessionStore.readSession(current).catch(() => null);
    if (!meta) {
      return null;
    }
    const binding = normalizeSupervisorThreadBinding(meta.supervisorThread);
    if (binding) {
      return binding;
    }
    current = meta.options.followupSessionId?.trim();
  }
  return null;
}

async function reusableSupervisorPromptResponse(
  meta: SessionMetadata,
): Promise<
  | { ok: true; sessionId: string; output: string; conversationId?: string }
  | { ok: false; error: string; sessionId?: string }
> {
  const sessionStatus = meta.response?.status ?? meta.status;
  const incompleteReason = meta.response?.incompleteReason;
  const assistantOutput = await readReusableSupervisorPromptOutput(meta);
  if (sessionStatus === "pending" || sessionStatus === "running") {
    return {
      ok: false,
      sessionId: meta.id,
      error: `Session ${meta.id} is already ${sessionStatus}. Reattach later with: oracle session ${meta.id}`,
    };
  }
  return finalizeSupervisorPromptOperationResult(
    meta.id,
    sessionStatus,
    incompleteReason,
    assistantOutput,
    normalizeSupervisorThreadBinding(meta.supervisorThread)?.conversationId ??
      meta.browser?.runtime?.conversationId,
  );
}

async function findReusableSupervisorPromptResponse(
  request: SupervisorPromptRequest,
  requestedModel: string,
  browserConfig: BrowserSessionConfig,
  expectedSupervisorThread?: SupervisorThreadBindingMetadata | null,
): Promise<
  | { ok: true; sessionId: string; output: string; conversationId?: string }
  | { ok: false; error: string; sessionId?: string }
  | null
> {
  const candidate = pickReusableSupervisorPromptSession(
    await sessionStore.listSessions().catch(() => []),
    request,
    requestedModel,
    browserConfig,
    expectedSupervisorThread,
  );
  return candidate ? await reusableSupervisorPromptResponse(candidate) : null;
}

function supervisorBrowserThrottleProfileKey(config: BrowserSessionConfig): string {
  const throttleScope = config.supervisorThrottleScope?.trim();
  if (throttleScope) {
    return `scope:${throttleScope}`;
  }
  return (
    config.manualLoginProfileDir?.trim() ||
    config.url?.trim() ||
    config.chatgptUrl?.trim() ||
    "default"
  );
}

function supervisorBrowserMaxRequestsPerWindow(requestedModel: string): number {
  return requestedModel.toLowerCase().includes("pro")
    ? SUPERVISOR_BROWSER_PRO_MAX_REQUESTS
    : SUPERVISOR_BROWSER_DEFAULT_MAX_REQUESTS;
}

function pruneSupervisorBrowserRequestTimes(
  entry: SupervisorBrowserThrottleEntry | undefined,
  nowMs: number,
): number[] {
  const requestStartedAt = Array.isArray(entry?.requestStartedAt) ? entry.requestStartedAt : [];
  return requestStartedAt
    .map((value) => Date.parse(value))
    .filter(
      (timestamp) => Number.isFinite(timestamp) && nowMs - timestamp < SUPERVISOR_BROWSER_WINDOW_MS,
    )
    .sort((left, right) => left - right);
}

function isSupervisorBrowserLeaseWellFormed(
  lease: SupervisorBrowserThrottleLease | null | undefined,
): lease is SupervisorBrowserThrottleLease {
  return Boolean(
    lease &&
    typeof lease.ownerId === "string" &&
    lease.ownerId.trim() &&
    Number.isFinite(lease.pid) &&
    lease.pid > 0 &&
    typeof lease.acquiredAt === "string" &&
    typeof lease.expiresAt === "string",
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readProcessStartMarker(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0 || process.platform === "win32") {
    return null;
  }
  try {
    const marker = execFileSync("ps", ["-p", `${Math.trunc(pid)}`, "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
    return marker || null;
  } catch {
    return null;
  }
}

function supervisorBrowserLeaseMatchesLiveProcess(
  lease: SupervisorBrowserThrottleLease,
  {
    isProcessAliveFn = isProcessAlive,
    readProcessStartMarkerFn = readProcessStartMarker,
  }: {
    isProcessAliveFn?: (pid: number) => boolean;
    readProcessStartMarkerFn?: (pid: number) => string | null;
  } = {},
): boolean {
  if (!isProcessAliveFn(lease.pid)) {
    return false;
  }
  const expectedMarker = lease.processStartMarker?.trim();
  if (!expectedMarker) {
    return true;
  }
  return readProcessStartMarkerFn(lease.pid) === expectedMarker;
}

function supervisorBrowserLeaseMatchesOwnerIdentity(
  lease: SupervisorBrowserThrottleLease | null | undefined,
  {
    ownerId,
    ownerPid = process.pid,
    ownerProcessStartMarker = readProcessStartMarker(ownerPid),
  }: {
    ownerId?: string;
    ownerPid?: number;
    ownerProcessStartMarker?: string | null;
  } = {},
): boolean {
  if (!lease || !ownerId || lease.ownerId !== ownerId || lease.pid !== ownerPid) {
    return false;
  }
  const expectedMarker = lease.processStartMarker?.trim();
  const currentMarker = ownerProcessStartMarker?.trim();
  if (!expectedMarker || !currentMarker) {
    return true;
  }
  return expectedMarker === currentMarker;
}

function sanitizeSupervisorBrowserThrottleEntry(
  entry: SupervisorBrowserThrottleEntry | undefined,
  nowMs: number,
  {
    ownerId,
    ownerPid = process.pid,
    ownerProcessStartMarker = readProcessStartMarker(ownerPid),
    isProcessAliveFn = isProcessAlive,
    readProcessStartMarkerFn = readProcessStartMarker,
  }: {
    ownerId?: string;
    ownerPid?: number;
    ownerProcessStartMarker?: string | null;
    isProcessAliveFn?: (pid: number) => boolean;
    readProcessStartMarkerFn?: (pid: number) => string | null;
  } = {},
): SupervisorBrowserThrottleEntry | undefined {
  if (!entry) {
    return undefined;
  }
  const requestStartedAt = pruneSupervisorBrowserRequestTimes(entry, nowMs).map((timestamp) =>
    new Date(timestamp).toISOString(),
  );
  const cooldownUntilMs = Date.parse(entry.cooldownUntil ?? "");
  const cooldownUntil =
    Number.isFinite(cooldownUntilMs) && cooldownUntilMs > nowMs
      ? new Date(cooldownUntilMs).toISOString()
      : undefined;
  let activeLease = isSupervisorBrowserLeaseWellFormed(entry.activeLease)
    ? entry.activeLease
    : null;
  if (activeLease) {
    const expiresAtMs = Date.parse(activeLease.expiresAt);
    const isCurrentOwner = supervisorBrowserLeaseMatchesOwnerIdentity(activeLease, {
      ownerId,
      ownerPid,
      ownerProcessStartMarker,
    });
    const keepLease =
      Number.isFinite(expiresAtMs) &&
      (isCurrentOwner ||
        (expiresAtMs > nowMs &&
          supervisorBrowserLeaseMatchesLiveProcess(activeLease, {
            isProcessAliveFn,
            readProcessStartMarkerFn,
          })));
    if (!keepLease) {
      activeLease = null;
    }
  }
  if (!requestStartedAt.length && !cooldownUntil && !activeLease) {
    return undefined;
  }
  return {
    requestStartedAt: requestStartedAt.length ? requestStartedAt : undefined,
    cooldownUntil,
    activeLease,
  };
}

function sanitizeSupervisorBrowserThrottleState(
  state: SupervisorBrowserThrottleState,
  nowMs: number,
  options?: {
    ownerId?: string;
    ownerPid?: number;
    ownerProcessStartMarker?: string | null;
    isProcessAliveFn?: (pid: number) => boolean;
    readProcessStartMarkerFn?: (pid: number) => string | null;
  },
): SupervisorBrowserThrottleState {
  const profiles: Record<string, SupervisorBrowserThrottleEntry> = {};
  for (const [profileKey, entry] of Object.entries(state.profiles ?? {})) {
    const sanitized = sanitizeSupervisorBrowserThrottleEntry(entry, nowMs, options);
    if (sanitized) {
      profiles[profileKey] = sanitized;
    }
  }
  return Object.keys(profiles).length ? { profiles } : {};
}

export function computeSupervisorBrowserThrottleDecision(
  entry: SupervisorBrowserThrottleEntry | undefined,
  requestedModel: string,
  nowMs: number,
  options?: {
    ownerId?: string;
    ownerPid?: number;
    ownerProcessStartMarker?: string | null;
    isProcessAliveFn?: (pid: number) => boolean;
    readProcessStartMarkerFn?: (pid: number) => string | null;
  },
): SupervisorBrowserThrottleDecision {
  const sanitized = sanitizeSupervisorBrowserThrottleEntry(entry, nowMs, options);
  const activeLease = sanitized?.activeLease;
  if (
    activeLease &&
    !supervisorBrowserLeaseMatchesOwnerIdentity(activeLease, {
      ownerId: options?.ownerId,
      ownerPid: options?.ownerPid,
      ownerProcessStartMarker: options?.ownerProcessStartMarker,
    })
  ) {
    const expiresAtMs = Date.parse(activeLease.expiresAt);
    return {
      delayMs: Math.max(1_000, Number.isFinite(expiresAtMs) ? expiresAtMs - nowMs : 1_000),
      reason: "active-lease",
    };
  }
  const recentRequests = pruneSupervisorBrowserRequestTimes(sanitized, nowMs);
  const cooldownUntilMs = Date.parse(sanitized?.cooldownUntil ?? "");
  if (Number.isFinite(cooldownUntilMs) && cooldownUntilMs > nowMs) {
    return {
      delayMs: cooldownUntilMs - nowMs,
      reason: "rate-limit-cooldown",
    };
  }
  const lastRequestMs = recentRequests.at(-1);
  if (typeof lastRequestMs === "number") {
    const minGapDelayMs = SUPERVISOR_BROWSER_MIN_GAP_MS - (nowMs - lastRequestMs);
    if (minGapDelayMs > 0) {
      return {
        delayMs: minGapDelayMs,
        reason: "min-gap",
      };
    }
  }
  const maxRequestsPerWindow = supervisorBrowserMaxRequestsPerWindow(requestedModel);
  if (recentRequests.length >= maxRequestsPerWindow) {
    const oldestRequestMs = recentRequests[recentRequests.length - maxRequestsPerWindow];
    if (typeof oldestRequestMs === "number") {
      return {
        delayMs: oldestRequestMs + SUPERVISOR_BROWSER_WINDOW_MS - nowMs,
        reason: "window-budget",
      };
    }
  }
  return {
    delayMs: 0,
    reason: null,
  };
}

async function readSupervisorBrowserThrottleState(): Promise<SupervisorBrowserThrottleState> {
  try {
    const raw = await fs.readFile(resolveSupervisorBrowserThrottleFile(), "utf8");
    const parsed = JSON.parse(raw) as SupervisorBrowserThrottleState;
    const nowMs = Date.now();
    return typeof parsed === "object" && parsed
      ? sanitizeSupervisorBrowserThrottleState(parsed, nowMs)
      : {};
  } catch {
    return {};
  }
}

async function reserveSupervisorRuntimeAttachLease(log: (message?: string) => void): Promise<{
  profileKey: string;
  ownerId: string;
  ownerPid: number;
  ownerProcessStartMarker?: string;
  requestStartedAtMs: number;
}> {
  const profileKey = SUPERVISOR_BROWSER_PROFILE_DIR;
  const ownerId =
    process.env[SUPERVISOR_BROWSER_LEASE_OWNER_ID_ENV]?.trim() ||
    `${os.hostname()}:${process.pid}:${Date.now()}:${randomUUID()}`;
  if (!process.env[SUPERVISOR_BROWSER_LEASE_OWNER_ID_ENV]) {
    process.env[SUPERVISOR_BROWSER_LEASE_OWNER_ID_ENV] = ownerId;
  }
  const ownerPid = process.pid;
  const processStartMarker = readProcessStartMarker(process.pid) ?? undefined;
  while (true) {
    const decision = await withSupervisorBrowserThrottleLock(async () => {
      const nowMs = Date.now();
      const state = sanitizeSupervisorBrowserThrottleState(
        await readSupervisorBrowserThrottleState(),
        nowMs,
        { ownerId, ownerPid, ownerProcessStartMarker: processStartMarker },
      );
      const profiles = state.profiles ?? {};
      const entry = profiles[profileKey];
      const activeLease = entry?.activeLease;
      if (
        activeLease &&
        !supervisorBrowserLeaseMatchesOwnerIdentity(activeLease, {
          ownerId,
          ownerPid,
          ownerProcessStartMarker: processStartMarker,
        })
      ) {
        const expiresAtMs = Date.parse(activeLease.expiresAt);
        await writeSupervisorBrowserThrottleState({ profiles });
        return {
          delayMs: Math.max(
            SUPERVISOR_BROWSER_RUNTIME_ATTACH_RECHECK_MIN_MS,
            Number.isFinite(expiresAtMs)
              ? expiresAtMs - nowMs
              : SUPERVISOR_BROWSER_RUNTIME_ATTACH_RECHECK_MIN_MS,
          ),
          reason: "active-lease" as const,
        };
      }
      profiles[profileKey] = {
        ...entry,
        activeLease: {
          ownerId,
          pid: process.pid,
          hostname: os.hostname(),
          acquiredAt: new Date(nowMs).toISOString(),
          expiresAt: new Date(nowMs + SUPERVISOR_BROWSER_LEASE_TTL_MS).toISOString(),
          processStartMarker,
        },
      };
      await writeSupervisorBrowserThrottleState({ profiles });
      return {
        delayMs: 0,
        reason: null,
      };
    });
    if (decision.delayMs > 0 && decision.reason) {
      const waitMs = Math.min(decision.delayMs, SUPERVISOR_BROWSER_ACTIVE_LEASE_RECHECK_MS);
      log(
        `Supervisor browser throttle (${decision.reason}); waiting ${formatElapsed(waitMs)} before attaching to the Oracle runtime.`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    return {
      profileKey,
      ownerId,
      ownerPid,
      ownerProcessStartMarker: processStartMarker,
      requestStartedAtMs: Date.now(),
    };
  }
}

function resolveSupervisorBrowserThrottleFile(): string {
  const override = process.env[SUPERVISOR_BROWSER_THROTTLE_FILE_ENV]?.trim();
  return override || SUPERVISOR_BROWSER_THROTTLE_FILE;
}

function resolveSupervisorBrowserThrottleLockFile(): string {
  return `${resolveSupervisorBrowserThrottleFile()}.lock`;
}

async function writeSupervisorBrowserThrottleState(
  state: SupervisorBrowserThrottleState,
): Promise<void> {
  const target = resolveSupervisorBrowserThrottleFile();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(temp, target);
}

function parseSupervisorBrowserThrottleLock(
  payload: string | null,
): SupervisorBrowserThrottleLockRecord | null {
  if (!payload) {
    return null;
  }
  try {
    const parsed = JSON.parse(payload) as SupervisorBrowserThrottleLockRecord;
    if (!Number.isFinite(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    if (!parsed.lockId || typeof parsed.lockId !== "string") {
      return null;
    }
    if (!parsed.expiresAt || typeof parsed.expiresAt !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function supervisorBrowserThrottleLockMatchesLiveProcess(
  lock: SupervisorBrowserThrottleLockRecord,
): boolean {
  if (!isProcessAlive(lock.pid)) {
    return false;
  }
  const expectedMarker = lock.processStartMarker?.trim();
  if (!expectedMarker) {
    return true;
  }
  return readProcessStartMarker(lock.pid) === expectedMarker;
}

async function acquireSupervisorBrowserThrottleLock(): Promise<{
  lockPath: string;
  lockId: string;
}> {
  const lockPath = resolveSupervisorBrowserThrottleLockFile();
  const lockId = randomUUID();
  const startedAt = Date.now();
  const processStartMarker = readProcessStartMarker(process.pid) ?? undefined;

  for (;;) {
    try {
      const nowMs = Date.now();
      const payload: SupervisorBrowserThrottleLockRecord = {
        pid: process.pid,
        lockId,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + SUPERVISOR_BROWSER_THROTTLE_LOCK_TIMEOUT_MS).toISOString(),
        processStartMarker,
      };
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(lockPath, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
      return { lockPath, lockId };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") {
        throw error;
      }
      const existing = parseSupervisorBrowserThrottleLock(
        await fs.readFile(lockPath, "utf8").catch(() => null),
      );
      const existingExpiresAtMs = Date.parse(existing?.expiresAt ?? "");
      if (
        !existing ||
        !Number.isFinite(Date.parse(existing.createdAt)) ||
        !Number.isFinite(existingExpiresAtMs) ||
        existingExpiresAtMs <= Date.now() ||
        !supervisorBrowserThrottleLockMatchesLiveProcess(existing)
      ) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= SUPERVISOR_BROWSER_THROTTLE_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Supervisor browser throttle lock ${lockPath} is still held by pid ${existing.pid}.`,
        );
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(
            SUPERVISOR_BROWSER_THROTTLE_LOCK_POLL_MS,
            SUPERVISOR_BROWSER_THROTTLE_LOCK_TIMEOUT_MS - elapsed,
          ),
        ),
      );
    }
  }
}

async function releaseSupervisorBrowserThrottleLock(
  lockPath: string,
  lockId: string,
): Promise<void> {
  const existing = parseSupervisorBrowserThrottleLock(
    await fs.readFile(lockPath, "utf8").catch(() => null),
  );
  if (!existing || existing.lockId !== lockId) {
    return;
  }
  await fs.rm(lockPath, { force: true }).catch(() => undefined);
}

async function withSupervisorBrowserThrottleLock<T>(work: () => Promise<T>): Promise<T> {
  const lock = await acquireSupervisorBrowserThrottleLock();
  try {
    return await work();
  } finally {
    await releaseSupervisorBrowserThrottleLock(lock.lockPath, lock.lockId);
  }
}

async function reserveSupervisorBrowserRequestSlot(
  config: BrowserSessionConfig,
  requestedModel: string,
  log: (message?: string) => void,
): Promise<{
  profileKey: string;
  ownerId: string;
  ownerPid: number;
  ownerProcessStartMarker?: string;
  requestStartedAtMs: number;
}> {
  const profileKey = supervisorBrowserThrottleProfileKey(config);
  const ownerId =
    process.env[SUPERVISOR_BROWSER_LEASE_OWNER_ID_ENV]?.trim() ||
    `${os.hostname()}:${process.pid}:${Date.now()}:${randomUUID()}`;
  if (!process.env[SUPERVISOR_BROWSER_LEASE_OWNER_ID_ENV]) {
    process.env[SUPERVISOR_BROWSER_LEASE_OWNER_ID_ENV] = ownerId;
  }
  const ownerPid = process.pid;
  const processStartMarker = readProcessStartMarker(process.pid) ?? undefined;
  while (true) {
    const decision = await withSupervisorBrowserThrottleLock(async () => {
      const nowMs = Date.now();
      const state = sanitizeSupervisorBrowserThrottleState(
        await readSupervisorBrowserThrottleState(),
        nowMs,
        { ownerId },
      );
      const profiles = state.profiles ?? {};
      const entry = profiles[profileKey];
      const nextDecision = computeSupervisorBrowserThrottleDecision(entry, requestedModel, nowMs, {
        ownerId,
        ownerPid,
        ownerProcessStartMarker: processStartMarker,
      });
      if (nextDecision.delayMs > 0) {
        await writeSupervisorBrowserThrottleState({ profiles });
        return nextDecision;
      }
      profiles[profileKey] = {
        ...entry,
        activeLease: {
          ownerId,
          pid: process.pid,
          hostname: os.hostname(),
          acquiredAt: new Date(nowMs).toISOString(),
          expiresAt: new Date(nowMs + SUPERVISOR_BROWSER_LEASE_TTL_MS).toISOString(),
          processStartMarker,
        },
      };
      await writeSupervisorBrowserThrottleState({ profiles });
      return nextDecision;
    });
    if (decision.delayMs > 0 && decision.reason) {
      const waitMs =
        decision.reason === "active-lease"
          ? Math.min(decision.delayMs, SUPERVISOR_BROWSER_ACTIVE_LEASE_RECHECK_MS)
          : decision.delayMs;
      log(
        `Supervisor browser throttle (${decision.reason}); waiting ${formatElapsed(waitMs)} before the next Oracle request.`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    return {
      profileKey,
      ownerId,
      ownerPid,
      ownerProcessStartMarker: processStartMarker,
      requestStartedAtMs: Date.now(),
    };
  }
}

async function commitSupervisorBrowserRequestSlot(reservation: {
  profileKey: string;
  ownerId: string;
  ownerPid?: number;
  ownerProcessStartMarker?: string;
  requestStartedAtMs: number;
}): Promise<void> {
  await withSupervisorBrowserThrottleLock(async () => {
    const nowMs = Date.now();
    const state = sanitizeSupervisorBrowserThrottleState(
      await readSupervisorBrowserThrottleState(),
      nowMs,
      {
        ownerId: reservation.ownerId,
        ownerPid: reservation.ownerPid,
        ownerProcessStartMarker: reservation.ownerProcessStartMarker,
      },
    );
    const profiles = state.profiles ?? {};
    const entry = profiles[reservation.profileKey];
    if (
      !supervisorBrowserLeaseMatchesOwnerIdentity(entry?.activeLease, {
        ownerId: reservation.ownerId,
        ownerPid: reservation.ownerPid,
        ownerProcessStartMarker: reservation.ownerProcessStartMarker,
      })
    ) {
      return;
    }
    const activeLease = entry?.activeLease;
    if (!activeLease) {
      return;
    }
    const recentRequests = pruneSupervisorBrowserRequestTimes(entry, nowMs);
    profiles[reservation.profileKey] = {
      ...entry,
      requestStartedAt: [...recentRequests, reservation.requestStartedAtMs].map((timestamp) =>
        new Date(timestamp).toISOString(),
      ),
      activeLease: {
        ...activeLease,
        expiresAt: new Date(nowMs + SUPERVISOR_BROWSER_LEASE_TTL_MS).toISOString(),
      },
    };
    await writeSupervisorBrowserThrottleState({ profiles });
  });
}

async function releaseSupervisorBrowserRequestSlot(reservation: {
  profileKey: string;
  ownerId: string;
  ownerPid?: number;
  ownerProcessStartMarker?: string;
}): Promise<void> {
  await withSupervisorBrowserThrottleLock(async () => {
    const nowMs = Date.now();
    const state = sanitizeSupervisorBrowserThrottleState(
      await readSupervisorBrowserThrottleState(),
      nowMs,
      {
        ownerId: reservation.ownerId,
        ownerPid: reservation.ownerPid,
        ownerProcessStartMarker: reservation.ownerProcessStartMarker,
      },
    );
    const profiles = state.profiles ?? {};
    const entry = profiles[reservation.profileKey];
    if (
      !supervisorBrowserLeaseMatchesOwnerIdentity(entry?.activeLease, {
        ownerId: reservation.ownerId,
        ownerPid: reservation.ownerPid,
        ownerProcessStartMarker: reservation.ownerProcessStartMarker,
      })
    ) {
      return;
    }
    const nextEntry = sanitizeSupervisorBrowserThrottleEntry(
      {
        ...entry,
        activeLease: null,
      },
      nowMs,
      {
        ownerId: reservation.ownerId,
        ownerPid: reservation.ownerPid,
        ownerProcessStartMarker: reservation.ownerProcessStartMarker,
      },
    );
    if (nextEntry) {
      profiles[reservation.profileKey] = nextEntry;
    } else {
      delete profiles[reservation.profileKey];
    }
    await writeSupervisorBrowserThrottleState({ profiles });
  });
}

function supervisorSignalExitCode(signal: NodeJS.Signals): number {
  switch (signal) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    default:
      return 1;
  }
}

function installSupervisorBrowserRequestSlotSignalCleanup(
  reservation: {
    profileKey: string;
    ownerId: string;
    ownerPid?: number;
    ownerProcessStartMarker?: string;
    requestStartedAtMs: number;
  },
  releaseReservation: typeof releaseSupervisorBrowserRequestSlot = releaseSupervisorBrowserRequestSlot,
  processLike: Pick<NodeJS.Process, "on" | "off"> = process,
  exitFn: (code: number) => void = (code) => process.exit(code),
  log: (message?: string) => void = () => undefined,
): { dispose: () => void; waitForCleanup: () => Promise<void> } {
  let active = true;
  let cleanup: Promise<void> | null = null;
  const listeners = new Map<NodeJS.Signals, () => void>();

  const dispose = () => {
    if (!active) {
      return;
    }
    active = false;
    for (const [signal, handler] of listeners) {
      processLike.off(signal, handler);
    }
    listeners.clear();
  };

  const runCleanup = (signal: NodeJS.Signals) => {
    if (!active) {
      return cleanup ?? Promise.resolve();
    }
    dispose();
    cleanup ??= (async () => {
      try {
        await releaseReservation(reservation);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Supervisor browser cleanup after ${signal} failed: ${message}`);
      } finally {
        exitFn(supervisorSignalExitCode(signal));
      }
    })();
    return cleanup;
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      void runCleanup(signal);
    };
    listeners.set(signal, handler);
    processLike.on(signal, handler);
  }

  return {
    dispose,
    waitForCleanup: async () => {
      await cleanup;
    },
  };
}

async function heartbeatSupervisorBrowserRequestSlot(reservation: {
  profileKey: string;
  ownerId: string;
  ownerPid?: number;
  ownerProcessStartMarker?: string;
}): Promise<void> {
  await withSupervisorBrowserThrottleLock(async () => {
    const nowMs = Date.now();
    const state = sanitizeSupervisorBrowserThrottleState(
      await readSupervisorBrowserThrottleState(),
      nowMs,
      {
        ownerId: reservation.ownerId,
        ownerPid: reservation.ownerPid,
        ownerProcessStartMarker: reservation.ownerProcessStartMarker,
      },
    );
    const profiles = state.profiles ?? {};
    const entry = profiles[reservation.profileKey];
    if (
      !supervisorBrowserLeaseMatchesOwnerIdentity(entry?.activeLease, {
        ownerId: reservation.ownerId,
        ownerPid: reservation.ownerPid,
        ownerProcessStartMarker: reservation.ownerProcessStartMarker,
      })
    ) {
      throw new Error("Supervisor browser lease ownership was lost.");
    }
    const activeLease = entry?.activeLease;
    if (!activeLease) {
      throw new Error("Supervisor browser lease disappeared.");
    }
    profiles[reservation.profileKey] = {
      ...entry,
      activeLease: {
        ...activeLease,
        expiresAt: new Date(nowMs + SUPERVISOR_BROWSER_LEASE_TTL_MS).toISOString(),
      },
    };
    await writeSupervisorBrowserThrottleState({ profiles });
  });
}

async function withSupervisorBrowserLeaseHeartbeat<T>(
  reservation: {
    profileKey: string;
    ownerId: string;
    ownerPid?: number;
    ownerProcessStartMarker?: string;
  },
  log: (message?: string) => void,
  work: () => Promise<T>,
): Promise<T> {
  let settled = false;
  let heartbeat: Promise<void> | null = null;
  let heartbeatReject: ((error: Error) => void) | null = null;
  const heartbeatFailure = new Promise<never>((_, reject) => {
    heartbeatReject = reject;
  });
  const tick = () => {
    if (settled || heartbeat) {
      return;
    }
    heartbeat = heartbeatSupervisorBrowserRequestSlot(reservation)
      .catch((error) => {
        const failure =
          error instanceof Error
            ? error
            : new Error(`Supervisor browser lease heartbeat failed: ${String(error)}`);
        log(failure.message);
        heartbeatReject?.(failure);
      })
      .finally(() => {
        heartbeat = null;
      });
  };
  const timer = setInterval(tick, SUPERVISOR_BROWSER_LEASE_HEARTBEAT_MS);
  timer.unref?.();
  const workPromise = Promise.resolve().then(work);
  void workPromise.catch(() => undefined);
  try {
    return await Promise.race([workPromise, heartbeatFailure]);
  } finally {
    settled = true;
    clearInterval(timer);
    const activeHeartbeat = heartbeat;
    await Promise.resolve(activeHeartbeat).then(
      () => undefined,
      () => undefined,
    );
  }
}

export async function withSupervisorRuntimeAttachLease<T>(
  log: (message?: string) => void,
  work: () => Promise<T>,
): Promise<T> {
  const reservation = await reserveSupervisorRuntimeAttachLease(log);
  try {
    return await withSupervisorBrowserLeaseHeartbeat(reservation, log, work);
  } finally {
    await releaseSupervisorBrowserRequestSlot(reservation);
  }
}

async function markSupervisorBrowserRateLimit(
  config: BrowserSessionConfig,
  reservation: {
    profileKey: string;
    ownerId: string;
    ownerPid?: number;
    ownerProcessStartMarker?: string;
  },
  log: (message?: string) => void,
): Promise<void> {
  const profileKey = supervisorBrowserThrottleProfileKey(config);
  await withSupervisorBrowserThrottleLock(async () => {
    const nowMs = Date.now();
    const cooldownUntil = new Date(nowMs + SUPERVISOR_BROWSER_RATE_LIMIT_COOLDOWN_MS).toISOString();
    const state = sanitizeSupervisorBrowserThrottleState(
      await readSupervisorBrowserThrottleState(),
      nowMs,
      {
        ownerId: reservation.ownerId,
        ownerPid: reservation.ownerPid,
        ownerProcessStartMarker: reservation.ownerProcessStartMarker,
      },
    );
    const profiles = state.profiles ?? {};
    const entry = profiles[profileKey];
    profiles[profileKey] = {
      ...entry,
      requestStartedAt: pruneSupervisorBrowserRequestTimes(entry, nowMs).map((timestamp) =>
        new Date(timestamp).toISOString(),
      ),
      cooldownUntil,
    };
    await writeSupervisorBrowserThrottleState({ profiles });
  });
  log(
    `Supervisor browser cooldown armed for ${formatElapsed(SUPERVISOR_BROWSER_RATE_LIMIT_COOLDOWN_MS)} after a ChatGPT rate-limit response.`,
  );
}

async function readSupervisorPromptCompletionSnapshot(
  sessionId: string,
  outputPath: string,
  readSession: (sessionId: string) => Promise<{
    status?: string;
    response?: { incompleteReason?: string | null; assistantOutput?: string };
  } | null> = (id) => sessionStore.readSession(id),
  readOutput: (outputPath: string) => Promise<string> = (target) =>
    fs.readFile(target, "utf8").catch(() => ""),
): Promise<SupervisorPromptCompletionSnapshot> {
  const [meta, output] = await Promise.all([
    readSession(sessionId).catch(() => null),
    readOutput(outputPath).catch(() => ""),
  ]);
  const persistedOutput = String(meta?.response?.assistantOutput ?? "").trimEnd();
  const snapshotOutput = output.trimEnd() || persistedOutput;
  return {
    sessionStatus: meta?.status,
    incompleteReason: meta?.response?.incompleteReason,
    output: snapshotOutput,
  };
}

async function waitForPromiseSettlement<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof SUPERVISOR_PROMPT_RUN_STILL_PENDING> {
  if (timeoutMs <= 0) {
    return SUPERVISOR_PROMPT_RUN_STILL_PENDING;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await new Promise<T | typeof SUPERVISOR_PROMPT_RUN_STILL_PENDING>((resolve, reject) => {
      timer = setTimeout(() => {
        timer = null;
        resolve(SUPERVISOR_PROMPT_RUN_STILL_PENDING);
      }, timeoutMs);
      timer.unref?.();
      promise.then(resolve, reject);
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function closeWritableStream(stream?: NodeJS.WritableStream | null): Promise<void> {
  const writable = stream as
    | (NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean })
    | null
    | undefined;
  if (!writable || writable.destroyed || writable.writableEnded) {
    return;
  }
  const closed = once(writable, "close").then(() => undefined);
  writable.end();
  await closed.catch(() => undefined);
}

async function waitForSupervisorPromptRunOutcome({
  sessionId,
  outputPath,
  run,
  readSession,
  readOutput,
  pollIntervalMs = SUPERVISOR_PROMPT_COMPLETION_POLL_MS,
  runSettleGraceMs = 0,
}: {
  sessionId: string;
  outputPath: string;
  run: Promise<void>;
  readSession?: (sessionId: string) => Promise<{
    status?: string;
    response?: { incompleteReason?: string | null };
  } | null>;
  readOutput?: (outputPath: string) => Promise<string>;
  pollIntervalMs?: number;
  runSettleGraceMs?: number;
}): Promise<SupervisorPromptRunOutcome> {
  let settled = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const stopPolling = () => {
    settled = true;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };
  const waitForNextPoll = () =>
    new Promise<void>((resolve) => {
      pollTimer = setTimeout(() => {
        pollTimer = null;
        resolve();
      }, pollIntervalMs);
      pollTimer.unref?.();
    });
  const runOutcome = run
    .then<SupervisorPromptRunOutcome>(() => ({ kind: "run-finished" }))
    .catch<SupervisorPromptRunOutcome>((error) => ({ kind: "run-failed", error }));
  const completionOutcome = (async (): Promise<SupervisorPromptRunOutcome> => {
    while (!settled) {
      const snapshot = await readSupervisorPromptCompletionSnapshot(
        sessionId,
        outputPath,
        readSession,
        readOutput,
      );
      if (snapshot.sessionStatus === "completed") {
        if (runSettleGraceMs <= 0) {
          return { kind: "session-completed", snapshot };
        }
        const settledRun = await waitForPromiseSettlement(runOutcome, runSettleGraceMs);
        if (settledRun === SUPERVISOR_PROMPT_RUN_STILL_PENDING) {
          return { kind: "run-still-pending", snapshot };
        }
        if (settledRun.kind === "run-failed") {
          return settledRun;
        }
        return settledRun;
      }
      if (snapshot.sessionStatus === "error" || snapshot.sessionStatus === "cancelled") {
        if (runSettleGraceMs <= 0) {
          return { kind: "session-terminal", snapshot };
        }
        const settledRun = await waitForPromiseSettlement(runOutcome, runSettleGraceMs);
        if (settledRun === SUPERVISOR_PROMPT_RUN_STILL_PENDING) {
          return { kind: "run-still-pending", snapshot };
        }
        if (settledRun.kind === "run-failed") {
          return settledRun;
        }
        return { kind: "session-terminal", snapshot };
      }
      if (settled) {
        break;
      }
      await waitForNextPoll();
    }
    return await runOutcome;
  })();
  try {
    return await Promise.race([runOutcome, completionOutcome]);
  } finally {
    stopPolling();
  }
}

function finalizeSupervisorPromptOperationResult(
  sessionId: string,
  sessionStatus: string | undefined,
  incompleteReason: string | null | undefined,
  output: string,
  conversationId?: string,
):
  | { ok: true; sessionId: string; output: string; conversationId?: string }
  | { ok: false; error: string; sessionId?: string } {
  if (sessionStatus !== "completed") {
    const reasonSuffix = incompleteReason ? ` (${incompleteReason})` : "";
    return {
      ok: false,
      sessionId,
      error: `Session ${sessionId} did not complete${reasonSuffix}. Reattach later with: oracle session ${sessionId}`,
    };
  }
  if (!output.trim()) {
    return {
      ok: false,
      sessionId,
      error: `Session ${sessionId} completed without assistant output.`,
    };
  }
  return {
    ok: true,
    sessionId,
    output: output.trimEnd(),
    ...(conversationId?.trim() ? { conversationId: conversationId.trim() } : {}),
  };
}

async function supervisorPromptSessionConsumedQuota(sessionId: string): Promise<boolean> {
  const meta = await sessionStore.readSession(sessionId).catch(() => null);
  if (!meta) {
    return false;
  }
  if (meta.startedAt) {
    return true;
  }
  const responseStatus = normalizeSupervisorText(meta.response?.status);
  return meta.status !== "pending" || (responseStatus !== null && responseStatus !== "pending");
}

export async function runSupervisorPromptOperation(
  request: SupervisorPromptRequest,
): Promise<
  | { ok: true; sessionId: string; output: string; conversationId?: string }
  | { ok: false; error: string; sessionId?: string }
> {
  const requestedModel = request.model?.trim() || "gpt-5.4-pro";
  const sessionSlug = sanitizeSessionSlugBase(request.sessionSlug);
  if (!sessionSlug) {
    return {
      ok: false,
      error: "sessionSlug must include at least one alphanumeric character.",
    };
  }
  const normalizedRequest =
    sessionSlug === request.sessionSlug ? request : { ...request, sessionSlug };
  let browserModelStrategy: BrowserModelStrategy = "current";
  const requestedStrategy = request.browserModelStrategy?.trim();
  if (requestedStrategy) {
    const normalized = normalizeBrowserModelStrategy(requestedStrategy);
    if (normalized) {
      browserModelStrategy = normalized;
    }
  }
  const browserModelLabel = request.browserModelLabel?.trim() || undefined;
  const browserThinkingTime = request.browserThinkingTime;

  const { config: userConfig } = await loadUserConfig();
  const cwd = request.cwd?.trim() || process.cwd();
  const files = Array.isArray(request.files) ? request.files.filter(Boolean) : [];
  const { runOptions } = mapConsultToRunOptions({
    prompt: request.prompt,
    files,
    model: requestedModel,
    engine: "browser",
    browserAttachments: files.length > 0 ? "always" : undefined,
    userConfig,
    env: process.env,
  });
  const outputPath = path.join(
    os.tmpdir(),
    `oracle-supervisor-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
  );
  runOptions.followupSessionId = request.followupSession?.trim() || undefined;
  runOptions.renderPlain = true;
  runOptions.silent = true;
  runOptions.writeOutputPath = outputPath;

  const resolvedRemote = resolveRemoteServiceConfig({ userConfig, env: process.env });
  const browserGuard = ensureBrowserAvailable("browser", {
    remoteHost: resolvedRemote.host,
    launcher: userConfig.browser?.launcher ?? null,
  });
  if (browserGuard) {
    return { ok: false, error: browserGuard };
  }

  let browserDeps: BrowserSessionRunnerDeps | undefined;
  if (resolvedRemote.host) {
    if (!resolvedRemote.token) {
      return {
        ok: false,
        error: `Remote host configured (${resolvedRemote.host}) but remote token is missing.`,
      };
    }
    browserDeps = {
      executeBrowser: createRemoteBrowserExecutor({
        host: resolvedRemote.host,
        token: resolvedRemote.token,
      }),
    };
  }

  const browserConfig = buildSupervisorBrowserConfig({
    userConfig,
    env: process.env,
    runModel: runOptions.model,
    inputModel: requestedModel,
    supervisorChatgptUrl: await resolveSupervisorChatgptUrl({
      userConfig,
      env: process.env,
    }),
    browserModelLabel,
    browserModelStrategy,
    browserThinkingTime,
    supervisorThrottleScope: resolvedRemote.host ? `remote:${resolvedRemote.host}` : undefined,
    defaultManualLoginCookieSync: resolvedRemote.host ? false : process.platform === "darwin",
    useDedicatedHiddenProfile: !resolvedRemote.host,
  });
  const expectedSupervisorThread = await resolveSupervisorThreadBinding(
    normalizedRequest.followupSession,
  );
  const reusableResponse = await findReusableSupervisorPromptResponse(
    normalizedRequest,
    requestedModel,
    browserConfig,
    expectedSupervisorThread,
  );
  if (reusableResponse) {
    return reusableResponse;
  }
  const reservation = await reserveSupervisorBrowserRequestSlot(
    browserConfig,
    requestedModel,
    () => undefined,
  );
  let releaseReservation = true;
  let sessionMeta: Awaited<ReturnType<typeof sessionStore.createSession>> | undefined;
  let logWriter: ReturnType<typeof sessionStore.createLogWriter> | undefined;
  const log = (line?: string): void => logWriter?.logLine(line);
  const write = (chunk: string): boolean => {
    logWriter?.writeChunk(chunk);
    return true;
  };
  const signalCleanup = installSupervisorBrowserRequestSlotSignalCleanup(
    reservation,
    releaseSupervisorBrowserRequestSlot,
    process,
    (code) => process.exit(code),
    log,
  );
  const reusableResponseAfterReservation = await findReusableSupervisorPromptResponse(
    normalizedRequest,
    requestedModel,
    browserConfig,
    expectedSupervisorThread,
  );
  if (reusableResponseAfterReservation) {
    signalCleanup.dispose();
    await releaseSupervisorBrowserRequestSlot(reservation);
    return reusableResponseAfterReservation;
  }

  let requestSlotCommitted = false;
  const commitReservationIfNeeded = async () => {
    if (requestSlotCommitted || !sessionMeta) {
      return;
    }
    if (!(await supervisorPromptSessionConsumedQuota(sessionMeta.id))) {
      return;
    }
    await commitSupervisorBrowserRequestSlot(reservation);
    requestSlotCommitted = true;
  };

  try {
    let createdSessionMeta = await sessionStore.createSession(
      {
        ...runOptions,
        mode: "browser",
        slug: sessionSlug,
        browserConfig,
        waitPreference: true,
      },
      cwd,
      { enabled: false, sound: false },
      sessionSlug,
    );
    if (expectedSupervisorThread) {
      createdSessionMeta = await sessionStore.updateSession(createdSessionMeta.id, {
        supervisorThread: expectedSupervisorThread,
      });
    }
    sessionMeta = createdSessionMeta;
    logWriter = sessionStore.createLogWriter(createdSessionMeta.id);
    const runOutcome = await withSupervisorBrowserLeaseHeartbeat(reservation, log, () =>
      waitForSupervisorPromptRunOutcome({
        sessionId: createdSessionMeta.id,
        outputPath,
        run: performSessionRun({
          sessionMeta: createdSessionMeta,
          runOptions,
          mode: "browser",
          browserConfig,
          cwd,
          log,
          write,
          version: getCliVersion(),
          notifications: { enabled: false, sound: false },
          muteStdout: true,
          browserDeps,
        }),
        runSettleGraceMs: SUPERVISOR_PROMPT_RUN_SETTLE_GRACE_MS,
      }),
    );
    if (runOutcome.kind === "run-failed") {
      throw runOutcome.error;
    }
    if (runOutcome.kind === "run-still-pending") {
      releaseReservation = false;
      const sessionStatus = runOutcome.snapshot.sessionStatus ?? "unknown";
      throw new Error(
        `Session runner did not settle within ${formatElapsed(SUPERVISOR_PROMPT_RUN_SETTLE_GRACE_MS)} after session status became ${sessionStatus}; keeping the supervisor browser lease active until TTL expiry to prevent concurrent runtime reuse.`,
      );
    }
    await commitReservationIfNeeded();
    const completionSnapshot =
      runOutcome.kind === "session-completed" || runOutcome.kind === "session-terminal"
        ? runOutcome.snapshot
        : await readSupervisorPromptCompletionSnapshot(createdSessionMeta.id, outputPath);
    return finalizeSupervisorPromptOperationResult(
      createdSessionMeta.id,
      completionSnapshot.sessionStatus,
      completionSnapshot.incompleteReason,
      completionSnapshot.output,
      expectedSupervisorThread?.conversationId,
    );
  } catch (error) {
    await commitReservationIfNeeded();
    const userError = asOracleUserError(error);
    const stage = userError?.details?.stage;
    if (userError?.category === "browser-automation" && stage === "assistant-rate-limit") {
      await markSupervisorBrowserRateLimit(browserConfig, reservation, () => undefined);
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Session ${sessionMeta?.id ?? sessionSlug} failed: ${message}`,
      sessionId: sessionMeta?.id,
    };
  } finally {
    signalCleanup.dispose();
    if (releaseReservation) {
      await releaseSupervisorBrowserRequestSlot(reservation);
    } else {
      log("Supervisor browser lease release deferred because the runner was still pending.");
    }
    await closeWritableStream(logWriter?.stream);
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
  }
}

export const __test__ = {
  commitSupervisorBrowserRequestSlot,
  acquireSupervisorBrowserThrottleLock,
  computeSupervisorBrowserThrottleDecision,
  extractSupervisorPromptOutputFromLog,
  finalizeSupervisorPromptOperationResult,
  findRecentSupervisorProjectUrl,
  findReusableSupervisorPromptResponse,
  heartbeatSupervisorBrowserRequestSlot,
  markSupervisorBrowserRateLimit,
  pickReusableSupervisorPromptSession,
  releaseSupervisorBrowserRequestSlot,
  reserveSupervisorBrowserRequestSlot,
  reusableSupervisorPromptResponse,
  readProcessStartMarker,
  readSupervisorPromptCompletionSnapshot,
  readReusableSupervisorPromptOutput,
  reserveSupervisorRuntimeAttachLease,
  installSupervisorBrowserRequestSlotSignalCleanup,
  resolveSupervisorBrowserThrottleFile,
  resolveSupervisorBrowserThrottleLockFile,
  resolveConfiguredSupervisorChatgptUrl,
  resolveSupervisorChatgptUrl,
  sanitizeSupervisorBrowserThrottleEntry,
  sanitizeSupervisorBrowserThrottleState,
  sessionMatchesSupervisorPromptRequest,
  supervisorPromptSessionConsumedQuota,
  supervisorBrowserThrottleProfileKey,
  supervisorBrowserLeaseMatchesLiveProcess,
  withSupervisorRuntimeAttachLease,
  waitForPromiseSettlement,
  closeWritableStream,
  waitForSupervisorPromptRunOutcome,
};
