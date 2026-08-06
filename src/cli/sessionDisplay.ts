import chalk from "chalk";
import kleur from "kleur";
import path from "node:path";
import type {
  SessionMetadata,
  SessionTransportMetadata,
  SessionUserErrorMetadata,
} from "../sessionStore.js";
import type { OracleResponseMetadata } from "../oracle.js";
import {
  formatBrowserModelSelectionEvidence,
  formatSessionBrowserModelWithRequestedKey,
  resolveSessionBrowserModelDisplayName,
} from "../browser/modelDisplay.js";
import { renderMarkdownAnsi } from "./markdownRenderer.js";
import { formatFinishLine } from "../oracle/finishLine.js";
import { commitSessionModelProjection, sessionStore, wait } from "../sessionStore.js";
import { formatTokenCount, formatTokenValue } from "../oracle/runUtils.js";
import {
  formatSessionTableHeader,
  formatSessionTableRow,
  resolveSessionCost,
} from "./sessionTable.js";
import {
  abbreviateResponseId,
  buildResponseOwnerIndex,
  resolveSessionLineage,
} from "./sessionLineage.js";
import { formatSessionExecutionLabel } from "./sessionLifecycle.js";
import { hasRemoteRecoveryAuthority } from "./browserRuntimeAuthority.js";
import {
  isDeepResearchPlaceholderCapture,
  isDeepResearchToolCallPlaceholder,
  orchestrateBrowserAttachAuthority,
} from "./browserAttachController.js";

export { isDeepResearchPlaceholderCapture };

const isTty = (): boolean => Boolean(process.stdout.isTTY);
const dim = (text: string): string => (isTty() ? kleur.dim(text) : text);
export const MAX_RENDER_BYTES = 200_000;

function isProcessAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ESRCH" || code === "EINVAL") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    return true;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ShowStatusOptions {
  hours: number;
  includeAll: boolean;
  limit: number;
  showExamples?: boolean;
  modelFilter?: string;
}

const CLEANUP_TIP =
  'Tip: Run "oracle session --clear --hours 24" to prune cached runs (add --all to wipe everything).';

export async function showStatus({
  hours,
  includeAll,
  limit,
  showExamples = false,
  modelFilter,
}: ShowStatusOptions): Promise<void> {
  const metas = await sessionStore.listSessions();
  const { entries, truncated, total } = sessionStore.filterSessions(metas, {
    hours,
    includeAll,
    limit,
  });
  const filteredEntries = modelFilter
    ? entries.filter((entry) => matchesModel(entry, modelFilter))
    : entries;
  const richTty = process.stdout.isTTY && chalk.level > 0;
  const responseOwners = buildResponseOwnerIndex(metas);
  if (!filteredEntries.length) {
    console.log(CLEANUP_TIP);
    if (showExamples) {
      printStatusExamples();
    }
    return;
  }
  console.log(chalk.bold("Recent Sessions"));
  console.log(formatSessionTableHeader(richTty));
  const treeRows = buildStatusTreeRows(filteredEntries, responseOwners);
  for (const row of treeRows) {
    const line = formatSessionTableRow(row.entry, { rich: richTty, displaySlug: row.displaySlug });
    const detachedParent =
      row.detachedParentLabel != null
        ? richTty
          ? chalk.gray(` <- ${row.detachedParentLabel}`)
          : ` <- ${row.detachedParentLabel}`
        : "";
    console.log(`${line}${detachedParent}`);
  }
  if (truncated) {
    const sessionsDir = sessionStore.sessionsDir();
    console.log(
      chalk.yellow(
        `Showing ${entries.length} of ${total} sessions from the requested range. Run "oracle session --clear" or delete entries in ${sessionsDir} to free space, or rerun with --status-limit/--status-all.`,
      ),
    );
  }
  if (showExamples) {
    printStatusExamples();
  }
}

export interface AttachSessionOptions {
  suppressMetadata?: boolean;
  renderMarkdown?: boolean;
  renderPrompt?: boolean;
  model?: string;
  /** Propagate a terminal worker failure through the attached CLI process. */
  propagateFailure?: boolean;
}

type LiveRenderState = {
  pending: string;
  inFence: boolean;
  fenceDelimiter?: string;
  inTable: boolean;
  renderedBytes: number;
  fallback: boolean;
  noticedFallback: boolean;
};

export async function attachSession(
  sessionId: string,
  options?: AttachSessionOptions,
): Promise<void> {
  const storedMetadata = await sessionStore.readSession(sessionId);
  if (!storedMetadata) {
    console.error(chalk.red(`No session found with ID ${sessionId}`));
    process.exitCode = 1;
    return;
  }
  let metadata: SessionMetadata = storedMetadata;
  if (metadata.mode === "browser" && metadata.status === "running" && !metadata.browser?.runtime) {
    await wait(250);
    const refreshed = await sessionStore.readSession(sessionId);
    if (refreshed) {
      metadata = refreshed;
    }
  }
  const normalizedModelFilter = options?.model?.trim().toLowerCase();
  if (normalizedModelFilter) {
    const availableModels =
      metadata.models?.map((model) => model.model.toLowerCase()) ??
      (metadata.model ? [metadata.model.toLowerCase()] : []);
    if (!availableModels.includes(normalizedModelFilter)) {
      console.error(chalk.red(`Model "${options?.model}" not found in session ${sessionId}.`));
      process.exitCode = 1;
      return;
    }
  }
  const initialStatus = metadata.status;
  const wantsRender = Boolean(options?.renderMarkdown);
  const isVerbose = Boolean(process.env.ORACLE_VERBOSE_RENDER);
  metadata = await orchestrateBrowserAttachAuthority(sessionId, metadata);
  if (!options?.suppressMetadata) {
    const reattachLine = buildReattachLine(metadata);
    if (reattachLine) {
      console.log(chalk.blue(reattachLine));
    }
    const chainLine = await buildSessionChainLine(metadata);
    if (chainLine) {
      console.log(dim(`Chain: ${chainLine}`));
    }
    console.log(`Created: ${metadata.createdAt}`);
    console.log(`Status: ${metadata.status}`);
    if (metadata.lifecycle) {
      const attached = metadata.lifecycle.attached ? "attached" : "detached";
      console.log(`Execution: ${formatSessionExecutionLabel(metadata)} (${attached})`);
      console.log(`Reattach: ${metadata.lifecycle.reattachCommand}`);
    }
    if (metadata.models && metadata.models.length > 0) {
      console.log("Models:");
      for (const run of metadata.models) {
        const usage = run.usage
          ? ` tok=${formatTokenCount(run.usage.outputTokens ?? 0)}/${formatTokenCount(run.usage.totalTokens ?? 0)}`
          : "";
        const modelLabel =
          (metadata.mode ?? metadata.options?.mode) === "browser"
            ? formatSessionBrowserModelWithRequestedKey(metadata, run.model)
            : run.model;
        console.log(`- ${chalk.cyan(modelLabel)} — ${run.status}${usage}`);
      }
    } else if (metadata.model) {
      const modelLabel =
        (metadata.mode ?? metadata.options?.mode) === "browser"
          ? formatSessionBrowserModelWithRequestedKey(metadata)
          : metadata.model;
      console.log(`Model: ${modelLabel}`);
    }
    const browserEvidence = formatBrowserEvidence(metadata);
    if (browserEvidence) {
      console.log("Browser evidence:");
      for (const line of browserEvidence) {
        console.log(dim(`- ${line}`));
      }
    }
    if (metadata.artifacts && metadata.artifacts.length > 0) {
      console.log("Artifacts:");
      for (const artifact of metadata.artifacts) {
        const label = artifact.label ?? artifact.kind;
        const size = artifact.sizeBytes ? ` (${formatBytes(artifact.sizeBytes)})` : "";
        const checksum = artifact.sha256 ? ` sha256=${artifact.sha256.slice(0, 12)}…` : "";
        const validation = artifact.validation
          ? ` validation=${artifact.validation.ok ? "ok" : (artifact.validation.error ?? "failed")}`
          : "";
        const transfer = artifact.transfer?.status ? ` transfer=${artifact.transfer.status}` : "";
        console.log(
          `- ${chalk.cyan(label)} — ${artifact.path}${size}${checksum}${validation}${transfer}`,
        );
      }
    }
    const responseSummary = formatResponseMetadata(metadata.response);
    if (responseSummary) {
      console.log(dim(`Response: ${responseSummary}`));
    }
    const transportSummary = formatTransportMetadata(metadata.transport);
    if (transportSummary) {
      console.log(dim(`Transport: ${transportSummary}`));
    }
    const userErrorSummary = formatUserErrorMetadata(metadata.error);
    if (userErrorSummary) {
      console.log(dim(`User error: ${userErrorSummary}`));
    }
  }

  const shouldTrimIntro =
    initialStatus === "completed" || initialStatus === "partial" || initialStatus === "error";
  if (options?.renderPrompt !== false) {
    const prompt = await readStoredPrompt(sessionId);
    if (prompt) {
      console.log(chalk.bold("Prompt:"));
      console.log(renderMarkdownAnsi(prompt));
      console.log(dim("---"));
    }
  }
  if (shouldTrimIntro) {
    const fullLog = await buildSessionLogForDisplay(sessionId, metadata, normalizedModelFilter);
    const trimmed = trimBeforeFirstAnswer(fullLog);
    const size = Buffer.byteLength(trimmed, "utf8");
    const canRender = wantsRender && isTty() && size <= MAX_RENDER_BYTES;
    if (wantsRender && size > MAX_RENDER_BYTES) {
      const msg = `Render skipped (log too large: ${size} bytes > ${MAX_RENDER_BYTES}). Showing raw text.`;
      console.log(dim(msg));
      if (isVerbose) {
        console.log(dim(`Verbose: renderMarkdown=true tty=${isTty()} size=${size}`));
      }
    } else if (wantsRender && !isTty()) {
      const msg = "Render requested but stdout is not a TTY; showing raw text.";
      console.log(dim(msg));
      if (isVerbose) {
        console.log(dim(`Verbose: renderMarkdown=true tty=${isTty()} size=${size}`));
      }
    }
    if (canRender) {
      if (isVerbose) {
        console.log(dim(`Verbose: rendering markdown (size=${size}, tty=${isTty()})`));
      }
      process.stdout.write(renderMarkdownAnsi(trimmed));
    } else {
      process.stdout.write(trimmed);
    }
    const summary = formatCompletionSummary(metadata, { includeSlug: true });
    if (summary) {
      console.log(`\n${chalk.green.bold(summary)}`);
    }
    if (options?.propagateFailure && metadata.status === "error") {
      process.exitCode = 1;
    }
    return;
  }

  if (wantsRender) {
    console.log(dim("Render will apply after completion; streaming raw text meanwhile..."));
    if (isVerbose) {
      console.log(dim(`Verbose: streaming phase renderMarkdown=true tty=${isTty()}`));
    }
  }

  const liveRenderState: LiveRenderState | null =
    wantsRender && isTty()
      ? {
          pending: "",
          inFence: false,
          inTable: false,
          renderedBytes: 0,
          fallback: false,
          noticedFallback: false,
        }
      : null;

  let lastLength = 0;
  const renderLiveChunk = (chunk: string): void => {
    if (!liveRenderState || chunk.length === 0) {
      process.stdout.write(chunk);
      return;
    }
    if (liveRenderState.fallback) {
      process.stdout.write(chunk);
      return;
    }

    liveRenderState.pending += chunk;
    const { chunks, remainder } = extractRenderableChunks(liveRenderState.pending, liveRenderState);
    liveRenderState.pending = remainder;

    for (const candidate of chunks) {
      const projected = liveRenderState.renderedBytes + Buffer.byteLength(candidate, "utf8");
      if (projected > MAX_RENDER_BYTES) {
        if (!liveRenderState.noticedFallback) {
          console.log(
            dim(`Render skipped (log too large: > ${MAX_RENDER_BYTES} bytes). Showing raw text.`),
          );
          liveRenderState.noticedFallback = true;
        }
        liveRenderState.fallback = true;
        process.stdout.write(candidate + liveRenderState.pending);
        liveRenderState.pending = "";
        return;
      }
      process.stdout.write(renderMarkdownAnsi(candidate));
      liveRenderState.renderedBytes += Buffer.byteLength(candidate, "utf8");
    }
  };

  const flushRemainder = (): void => {
    if (!liveRenderState || liveRenderState.fallback) {
      return;
    }
    if (liveRenderState.pending.length === 0) {
      return;
    }
    const text = liveRenderState.pending;
    liveRenderState.pending = "";
    const projected = liveRenderState.renderedBytes + Buffer.byteLength(text, "utf8");
    if (projected > MAX_RENDER_BYTES) {
      if (!liveRenderState.noticedFallback) {
        console.log(
          dim(`Render skipped (log too large: > ${MAX_RENDER_BYTES} bytes). Showing raw text.`),
        );
      }
      process.stdout.write(text);
      liveRenderState.fallback = true;
      return;
    }
    process.stdout.write(renderMarkdownAnsi(text));
  };

  const printNew = async () => {
    const text = await buildSessionLogForDisplay(sessionId, metadata, normalizedModelFilter);
    const nextChunk = text.slice(lastLength);
    if (nextChunk.length > 0) {
      renderLiveChunk(nextChunk);
      lastLength = text.length;
    }
  };

  await printNew();

  // biome-ignore lint/nursery/noUnnecessaryConditions: deliberate infinite poll
  while (true) {
    const latest = await sessionStore.readSession(sessionId);
    if (!latest) {
      break;
    }
    if (latest.status === "completed" || latest.status === "partial" || latest.status === "error") {
      await printNew();
      flushRemainder();
      if (!options?.suppressMetadata) {
        if (latest.status === "error" && latest.errorMessage) {
          console.log("\nResult:");
          console.log(`Session failed: ${latest.errorMessage}`);
        }
        if ((latest.status === "completed" || latest.status === "partial") && latest.usage) {
          const summary = formatCompletionSummary(latest, { includeSlug: true });
          if (summary) {
            const color = latest.status === "partial" ? chalk.yellow.bold : chalk.green.bold;
            console.log(`\n${color(summary)}`);
          } else {
            const usage = latest.usage;
            console.log(
              `\nFinished (tok i/o/r/t: ${usage.inputTokens}/${usage.outputTokens}/${usage.reasoningTokens}/${usage.totalTokens})`,
            );
          }
        }
      }
      if (options?.propagateFailure && latest.status === "error") {
        process.exitCode = 1;
      }
      break;
    }
    const controllerPid = latest.lifecycle?.workerPid ?? latest.browser?.runtime?.controllerPid;
    if (latest.lifecycle?.detached && controllerPid && !isProcessAlive(controllerPid)) {
      const settled = await sessionStore.readSession(sessionId);
      if (!settled) {
        break;
      }
      if (settled.status === "completed" || settled.status === "partial") {
        continue;
      }
      await printNew();
      flushRemainder();
      const message =
        settled.status === "error"
          ? (settled.errorMessage ?? "Detached worker failed.")
          : "Detached worker exited before the session reached a terminal state.";
      const failure = {
        category: "internal",
        message,
      } as const;
      const completedAt = new Date().toISOString();
      const response = { status: "incomplete" as const, incompleteReason: "incomplete-capture" };
      await commitSessionModelProjection(settled.id, {
        session: {
          status: "error",
          completedAt,
          errorMessage: message,
          response,
          error: failure,
        },
        ...(settled.model
          ? {
              model: {
                model: settled.model,
                updates: { status: "error", completedAt, response, error: failure },
              },
            }
          : {}),
      });
      console.log(chalk.yellow(`${message} Reattach via: ${settled.lifecycle?.reattachCommand}`));
      if (options?.propagateFailure) {
        process.exitCode = 1;
      }
      break;
    }
    await wait(1000);
    await printNew();
  }
}

export function formatResponseMetadata(metadata?: OracleResponseMetadata): string | null {
  if (!metadata) {
    return null;
  }
  const parts: string[] = [];
  if (metadata.responseId) {
    parts.push(`response=${metadata.responseId}`);
  }
  if (metadata.requestId) {
    parts.push(`request=${metadata.requestId}`);
  }
  if (metadata.status) {
    parts.push(`status=${metadata.status}`);
  }
  if (metadata.incompleteReason) {
    parts.push(`incomplete=${metadata.incompleteReason}`);
  }
  return parts.length > 0 ? parts.join(" | ") : null;
}

export function formatTransportMetadata(metadata?: SessionTransportMetadata): string | null {
  if (!metadata?.reason) {
    return null;
  }
  const reasonLabels: Record<string, string> = {
    "client-timeout": "client timeout (deadline exceeded)",
    "connection-lost": "connection lost before completion",
    "client-abort": "request aborted locally",
    unknown: "unknown transport failure",
  };
  const label = reasonLabels[metadata.reason] ?? "transport error";
  return `${metadata.reason} — ${label}`;
}

const TERMINAL_SAFE_DETAIL_KEYS: Record<string, true> = {
  action: true,
  actions: true,
  canretry: true,
  cause: true,
  causes: true,
  category: true,
  code: true,
  details: true,
  elapsedms: true,
  hint: true,
  inputtokens: true,
  message: true,
  mode: true,
  path: true,
  reason: true,
  remainingfollowups: true,
  requestedmodel: true,
  retryable: true,
  retriable: true,
  stage: true,
  status: true,
  sessionstatus: true,
  useraction: true,
  useractions: true,
  validationreason: true,
};

const TERMINAL_AUTHORITY_KEY_FRAGMENTS = [
  "runtime",
  "transactiontoken",
  "recoverycleanup",
  "remoterecovery",
  "websocket",
  "wsendpoint",
  "endpoint",
  "chromepid",
  "controllerpid",
  "processidentity",
  "processlaunchclaim",
  "launchclaim",
  "launch",
  "claim",
  "pid",
  "profile",
  "userdatadir",
  "cookiepath",
  "host",
  "port",
  "token",
  "secret",
  "credential",
  "authorization",
  "password",
  "target",
  "url",
] as const;

const MAX_TERMINAL_DETAIL_DEPTH = 8;

function normalizedDetailKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function sanitizeTerminalDiagnosticText(value: string): string {
  return value
    .replace(/\b(?:wss?|https?):\/\/[^\s"'`),}\]]+/giu, "[redacted-endpoint]")
    .replace(
      /(\b(?:transaction[ _-]?token|access[ _-]?token|auth(?:orization)?|bearer|token|secret|credential|password)\b\s*[:=]\s*)[^\s,"'}\]]+/giu,
      "$1[redacted]",
    )
    .replace(/\b(?:chrome|controller)\s*pid\s*[:=]?\s*\d+/giu, "[redacted-pid]")
    .replace(
      /\b(?:user[ _-]?data|profile(?: directory)?)\s*(?:path|dir(?:ectory)?)?\s*[:=]\s*[^\s,"'}\]]+/giu,
      "[redacted-path]",
    )
    .replace(
      /\b(?:user[ _-]?data|profile(?: directory)?)\s+(?:~\/|\/|[A-Za-z]:\\)[^\s,"'}\]]+/giu,
      "[redacted-path]",
    )
    .replace(/\b[A-Za-z0-9._~+/=:-]{32,}\b/gu, "[redacted]")
    .replace(/(?:~\/|\/(?:Users|home|tmp)\/)[^\s,"'}\]]+/gu, "[redacted-path]");
}

function projectTerminalDiagnostic(
  value: unknown,
  seen: WeakSet<object>,
  depth = 0,
): unknown | undefined {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return sanitizeTerminalDiagnosticText(value);
  if (typeof value !== "object" || depth >= MAX_TERMINAL_DETAIL_DEPTH || seen.has(value)) {
    return undefined;
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const projected: unknown[] = [];
    for (const entry of value) {
      const safeEntry = projectTerminalDiagnostic(entry, seen, depth + 1);
      if (safeEntry !== undefined) projected.push(safeEntry);
    }
    return projected.length > 0 ? projected : undefined;
  }

  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizedDetailKey(key);
    if (
      TERMINAL_AUTHORITY_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment)) ||
      !TERMINAL_SAFE_DETAIL_KEYS[normalized]
    ) {
      continue;
    }
    const safeEntry =
      normalized === "path" &&
      typeof entry === "string" &&
      (path.isAbsolute(entry) ||
        /^[A-Za-z]:[\\/]/u.test(entry) ||
        /(?:^|[\\/])(?:user[ _-]?data|profile)(?:[\\/]|$)/iu.test(entry))
        ? "[redacted-path]"
        : projectTerminalDiagnostic(entry, seen, depth + 1);
    if (safeEntry !== undefined) projected[key] = safeEntry;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

export function formatUserErrorMetadata(metadata?: SessionUserErrorMetadata): string | null {
  if (!metadata) {
    return null;
  }
  const parts: string[] = [];
  if (metadata.category) {
    parts.push(metadata.category);
  }
  if (metadata.message) {
    parts.push(`message=${sanitizeTerminalDiagnosticText(metadata.message)}`);
  }
  const projected = metadata.details
    ? projectTerminalDiagnostic(metadata.details, new WeakSet())
    : undefined;
  const details =
    projected && !Array.isArray(projected) ? (projected as Record<string, unknown>) : null;
  if (details) {
    parts.push(`details=${JSON.stringify(details)}`);
  }
  return parts.length > 0 ? parts.join(" | ") : null;
}

export function formatBrowserEvidence(metadata: SessionMetadata): string[] | null {
  const browser = metadata.browser;
  if (!browser?.modelSelection && (!browser?.warnings || browser.warnings.length === 0)) {
    return null;
  }
  const lines: string[] = [];
  const evidence = browser.modelSelection;
  if (evidence) {
    lines.push(`model ${formatBrowserModelSelectionEvidence(evidence, metadata.model)}`);
  }
  for (const warning of browser.warnings ?? []) {
    lines.push(`warning ${warning.code}: ${warning.message}`);
  }
  return lines.length > 0 ? lines : null;
}

export function buildReattachLine(metadata: SessionMetadata): string | null {
  if (!metadata.id) {
    return null;
  }
  const referenceTime = metadata.startedAt ?? metadata.createdAt;
  if (!referenceTime) {
    return null;
  }
  const elapsedLabel = formatRelativeDuration(referenceTime);
  if (!elapsedLabel) {
    return null;
  }
  if (metadata.status === "running") {
    return `Session ${metadata.id} reattached, request started ${elapsedLabel} ago.`;
  }
  const runtime = metadata.browser?.runtime;
  const hasRemoteRecovery = hasRemoteRecoveryAuthority(runtime);
  if (
    metadata.status === "error" &&
    hasRemoteRecovery &&
    !runtime?.recoveryCleanupResult?.settlementMode
  ) {
    return `Session ${metadata.id} retained recoverable remote browser authority from ${elapsedLabel} ago.`;
  }
  if (
    metadata.status === "completed" &&
    hasRemoteRecovery &&
    runtime?.recoveryCleanupResult?.settlementMode === "finalize"
  ) {
    return `Session ${metadata.id} retained pending remote browser finalization from ${elapsedLabel} ago.`;
  }
  return null;
}

export function trimBeforeFirstAnswer(logText: string): string {
  const marker = "Answer:";
  const index = logText.indexOf(marker);
  if (index === -1) {
    return logText;
  }
  const laterIndex = logText.lastIndexOf(marker);
  const reattachIndex = logText.indexOf("[reattach]", index + marker.length);
  if (laterIndex > index && reattachIndex > index && reattachIndex < laterIndex) {
    const firstCapture = logText.slice(index + marker.length, reattachIndex);
    if (isDeepResearchToolCallPlaceholder(firstCapture)) {
      return logText.slice(laterIndex);
    }
  }
  return logText.slice(index);
}

function formatRelativeDuration(referenceIso: string): string | null {
  const timestamp = Date.parse(referenceIso);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) {
    return null;
  }
  const seconds = Math.max(1, Math.round(diffMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    const parts = [`${hours}h`];
    if (remainingMinutes > 0) {
      parts.push(`${remainingMinutes}m`);
    }
    return parts.join(" ");
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  const parts = [`${days}d`];
  if (remainingHours > 0) {
    parts.push(`${remainingHours}h`);
  }
  if (remainingMinutes > 0 && days === 0) {
    parts.push(`${remainingMinutes}m`);
  }
  return parts.join(" ");
}

function printStatusExamples(): void {
  console.log("");
  console.log(chalk.bold("Usage Examples"));
  console.log(`${chalk.bold("  oracle status --hours 72 --limit 50")}`);
  console.log(dim("    Show 72h of history capped at 50 entries."));
  console.log(`${chalk.bold("  oracle status --clear --hours 168")}`);
  console.log(dim("    Delete sessions older than 7 days (use --all to wipe everything)."));
  console.log(`${chalk.bold("  oracle session <session-id>")}`);
  console.log(dim("    Attach to a specific running/completed session to stream its output."));
  console.log(dim(CLEANUP_TIP));
}

function matchesModel(entry: SessionMetadata, filter: string): boolean {
  const normalized = filter.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const models =
    entry.models?.map((model) => model.model.toLowerCase()) ??
    (entry.model ? [entry.model.toLowerCase()] : []);
  return models.includes(normalized);
}

interface StatusTreeRow {
  entry: SessionMetadata;
  displaySlug: string;
  detachedParentLabel?: string;
}

function formatLineageParentLabel(
  lineage: ReturnType<typeof resolveSessionLineage>,
): string | undefined {
  if (!lineage?.parentSessionId) {
    return undefined;
  }
  return lineage.parentResponseId
    ? `${lineage.parentSessionId} (${abbreviateResponseId(lineage.parentResponseId)})`
    : lineage.parentSessionId;
}

function buildStatusTreeRows(
  entries: SessionMetadata[],
  responseOwners: ReadonlyMap<string, string>,
): StatusTreeRow[] {
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const orderIndex = new Map(entries.map((entry, index) => [entry.id, index]));
  const lineageById = new Map<string, ReturnType<typeof resolveSessionLineage>>();
  const childMap = new Map<string, SessionMetadata[]>();

  for (const entry of entries) {
    const lineage = resolveSessionLineage(entry, responseOwners);
    lineageById.set(entry.id, lineage);
    const parentId = lineage?.parentSessionId;
    if (parentId && parentId !== entry.id && entryById.has(parentId)) {
      const siblings = childMap.get(parentId) ?? [];
      siblings.push(entry);
      childMap.set(parentId, siblings);
    }
  }

  for (const siblings of childMap.values()) {
    siblings.sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0));
  }

  const rows: StatusTreeRow[] = [];
  const visited = new Set<string>();

  const walkChild = (entry: SessionMetadata, ancestorHasMore: boolean[], isLast: boolean): void => {
    if (visited.has(entry.id)) {
      return;
    }
    visited.add(entry.id);
    const children = childMap.get(entry.id) ?? [];
    const nodeBranch = isLast ? "└─ " : "├─ ";
    const prefix = `${ancestorHasMore.map((hasMore) => (hasMore ? "│  " : "   ")).join("")}${nodeBranch}`;
    rows.push({ entry, displaySlug: `${prefix}${entry.id}` });

    children.forEach((child, index) => {
      walkChild(child, [...ancestorHasMore, !isLast], index === children.length - 1);
    });
  };

  const walkRoot = (entry: SessionMetadata): void => {
    if (visited.has(entry.id)) {
      return;
    }
    visited.add(entry.id);
    const lineage = lineageById.get(entry.id);
    const hiddenParent =
      lineage?.parentSessionId && !entryById.has(lineage.parentSessionId)
        ? formatLineageParentLabel(lineage)
        : undefined;
    const children = childMap.get(entry.id) ?? [];
    rows.push({ entry, displaySlug: entry.id, detachedParentLabel: hiddenParent });
    children.forEach((child, index) => {
      walkChild(child, [], index === children.length - 1);
    });
  };

  const roots = entries.filter((entry) => {
    const parentId = lineageById.get(entry.id)?.parentSessionId;
    return !(parentId && parentId !== entry.id && entryById.has(parentId));
  });

  roots.forEach((entry) => {
    walkRoot(entry);
  });
  entries.forEach((entry) => {
    walkRoot(entry);
  });
  return rows;
}

async function buildSessionChainLine(metadata: SessionMetadata): Promise<string | null> {
  const lineageWithoutLookup = resolveSessionLineage(metadata);
  if (!lineageWithoutLookup) {
    return `root -> ${metadata.id}`;
  }
  if (lineageWithoutLookup.parentSessionId) {
    return `${formatLineageParentLabel(lineageWithoutLookup)} -> ${metadata.id}`;
  }
  if (!lineageWithoutLookup.parentResponseId) {
    return `root -> ${metadata.id}`;
  }
  const sessions = await sessionStore.listSessions().catch(() => []);
  const responseOwners = buildResponseOwnerIndex(sessions);
  const lineage = resolveSessionLineage(metadata, responseOwners) ?? lineageWithoutLookup;
  if (lineage.parentSessionId) {
    return `${formatLineageParentLabel(lineage)} -> ${metadata.id}`;
  }
  if (!lineage.parentResponseId) {
    return `root -> ${metadata.id}`;
  }
  return `${abbreviateResponseId(lineage.parentResponseId)} -> ${metadata.id}`;
}

async function buildSessionLogForDisplay(
  sessionId: string,
  fallbackMeta: SessionMetadata,
  modelFilter?: string,
): Promise<string> {
  const normalizedFilter = modelFilter?.trim().toLowerCase();
  const freshMetadata = (await sessionStore.readSession(sessionId)) ?? fallbackMeta;
  const models = freshMetadata.models ?? fallbackMeta.models ?? [];
  if (models.length === 0) {
    if (normalizedFilter) {
      return await sessionStore.readModelLog(sessionId, modelFilter as string);
    }
    return await sessionStore.readLog(sessionId);
  }
  const candidates = normalizedFilter
    ? models.filter((model) => model.model.toLowerCase() === normalizedFilter)
    : models;
  if (candidates.length === 0) {
    return "";
  }
  const sections: string[] = [];
  let hasContent = false;
  for (const model of candidates) {
    const body = (await sessionStore.readModelLog(sessionId, model.model)) ?? "";
    if (body.trim().length > 0) {
      hasContent = true;
    }
    sections.push(`=== ${model.model} ===\n${body}`.trimEnd());
  }
  if (!hasContent) {
    // Fallback for runs that recorded output only in the session log (e.g., browser runs without per-model logs).
    return await sessionStore.readLog(sessionId);
  }
  return sections.join("\n\n");
}

function extractRenderableChunks(
  text: string,
  state: LiveRenderState,
): { chunks: string[]; remainder: string } {
  const chunks: string[] = [];
  let buffer = "";
  const lines = text.split(/(\n)/);
  for (let i = 0; i < lines.length; i += 1) {
    const segment = lines[i];
    if (segment === "\n") {
      buffer += segment;
      // Detect code fences
      const prev = lines[i - 1] ?? "";
      const fenceMatch = prev.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
      if (!state.inFence && fenceMatch) {
        state.inFence = true;
        state.fenceDelimiter = fenceMatch[2];
      } else if (state.inFence && state.fenceDelimiter && prev.startsWith(state.fenceDelimiter)) {
        state.inFence = false;
        state.fenceDelimiter = undefined;
      }

      const trimmed = prev.trim();
      if (!state.inFence) {
        if (!state.inTable && trimmed.startsWith("|") && trimmed.includes("|")) {
          state.inTable = true;
        }
        if (state.inTable && trimmed === "") {
          state.inTable = false;
        }
      }

      const safeBreak = !state.inFence && !state.inTable && trimmed === "";
      if (safeBreak) {
        chunks.push(buffer);
        buffer = "";
      }
      continue;
    }
    buffer += segment;
  }
  return { chunks, remainder: buffer };
}

export function formatCompletionSummary(
  metadata: SessionMetadata,
  options: { includeSlug?: boolean } = {},
): string | null {
  if (!metadata.usage || metadata.elapsedMs == null) {
    return null;
  }
  const modeLabel =
    (metadata.mode ?? metadata.options?.mode) === "browser"
      ? `${resolveSessionBrowserModelDisplayName(metadata)}[browser]`
      : (metadata.model ?? "n/a");
  const usage = metadata.usage;
  const cost = resolveSessionCost(metadata);
  const tokensDisplay = [
    usage.inputTokens ?? 0,
    usage.outputTokens ?? 0,
    usage.reasoningTokens ?? 0,
    usage.totalTokens ?? 0,
  ]
    .map((value, index) =>
      formatTokenValue(
        value,
        {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          reasoning_tokens: usage.reasoningTokens,
          total_tokens: usage.totalTokens,
        },
        index,
      ),
    )
    .join("/");
  const tokensPart = (() => {
    const parts = tokensDisplay.split("/");
    if (parts.length !== 4) return tokensDisplay;
    return `↑${parts[0]} ↓${parts[1]} ↻${parts[2]} Δ${parts[3]}`;
  })();
  const filesCount = metadata.options?.file?.length ?? 0;
  const filesPart = filesCount > 0 ? `files=${filesCount}` : null;
  const slugPart = options.includeSlug ? `slug=${metadata.id}` : null;
  const { line1, line2 } = formatFinishLine({
    elapsedMs: metadata.elapsedMs,
    model: modeLabel,
    costUsd: cost ?? null,
    tokensPart,
    detailParts: [filesPart, slugPart],
  });
  return line2 ? `${line1} | ${line2}` : line1;
}

async function readStoredPrompt(sessionId: string): Promise<string | null> {
  const request = await sessionStore.readRequest(sessionId);
  if (request?.prompt && request.prompt.trim().length > 0) {
    return request.prompt;
  }
  const meta = await sessionStore.readSession(sessionId);
  if (meta?.options?.prompt && meta.options.prompt.trim().length > 0) {
    return meta.options.prompt;
  }
  return null;
}
