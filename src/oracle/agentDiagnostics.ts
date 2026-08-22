import type { SessionMetadata } from "../sessionStore.js";

export type OracleAgentBlockerKind =
  | "login_required"
  | "captcha"
  | "permission"
  | "rate_limit"
  | "selector_drift"
  | "scope_mismatch"
  | "browser_unavailable"
  | "timeout"
  | "model_unavailable"
  | "unsupported_endpoint"
  | "unknown";

export type OracleAgentBlockerSeverity = "action_required" | "retryable" | "fatal" | "unknown";

export interface OracleAgentBlocker {
  kind: OracleAgentBlockerKind;
  severity: OracleAgentBlockerSeverity;
  message: string;
  remediation: string;
  resumable: boolean;
  resumeCommand?: string;
  evidence: {
    sessionId?: string;
    status?: string;
    mode?: string;
    incompleteReason?: string | null;
    transportReason?: string;
    errorCategory?: string;
    errorStage?: string;
    errorCode?: string;
    expectedUrl?: string;
    actualUrl?: string;
    errorSignals?: string[];
    errorBlockers?: string[];
  };
}

export interface AgentBlockerOptions {
  logTail?: string | null;
}

function readErrorStage(meta: SessionMetadata): string | undefined {
  const stage = meta.error?.details?.stage;
  return typeof stage === "string" ? stage : undefined;
}

function readErrorCode(meta: SessionMetadata): string | undefined {
  const code = meta.error?.details?.code;
  return typeof code === "string" ? code : undefined;
}

function readErrorStringDetail(meta: SessionMetadata, key: string): string | undefined {
  const details = meta.error?.details;
  const direct = details?.[key];
  if (typeof direct === "string") return direct;
  const nested = details?.details;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return undefined;
  const value = (nested as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readErrorStringArrayDetail(meta: SessionMetadata, key: string): string[] | undefined {
  const value = meta.error?.details?.[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : undefined;
}

function baseEvidence(meta: SessionMetadata): OracleAgentBlocker["evidence"] {
  const stage = readErrorStage(meta);
  const code = readErrorCode(meta);
  return {
    sessionId: meta.id,
    status: meta.status,
    mode: meta.mode,
    incompleteReason: meta.response?.incompleteReason,
    transportReason: meta.transport?.reason,
    errorCategory: meta.error?.category,
    errorStage: stage,
    errorCode: code,
    expectedUrl: readErrorStringDetail(meta, "expectedUrl"),
    actualUrl: readErrorStringDetail(meta, "actualUrl"),
    errorSignals: readErrorStringArrayDetail(meta, "signals"),
    errorBlockers: readErrorStringArrayDetail(meta, "blockers"),
  };
}

function reattachCommand(meta: SessionMetadata): string | undefined {
  return meta.id ? `oracle session ${meta.id}` : undefined;
}

function sourceText(meta: SessionMetadata, options: AgentBlockerOptions): string {
  return [
    meta.errorMessage,
    meta.error?.message,
    readErrorStage(meta),
    readErrorCode(meta),
    meta.transport?.reason,
    meta.response?.incompleteReason,
    options.logTail,
  ]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join("\n")
    .toLowerCase();
}

function sourceMatches(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function blocker(
  meta: SessionMetadata,
  fields: Omit<OracleAgentBlocker, "evidence">,
): OracleAgentBlocker {
  return {
    ...fields,
    evidence: baseEvidence(meta),
  };
}

export function buildAgentBlockerFromSession(
  meta: SessionMetadata,
  options: AgentBlockerOptions = {},
): OracleAgentBlocker | undefined {
  const stage = readErrorStage(meta);
  const code = readErrorCode(meta);
  const incompleteReason = meta.response?.incompleteReason;
  const transportReason = meta.transport?.reason;
  const text = sourceText(meta, options);

  if (
    stage === "assistant-timeout" ||
    incompleteReason === "incomplete-capture" ||
    transportReason === "client-timeout"
  ) {
    return blocker(meta, {
      kind: "timeout",
      severity: "retryable",
      message: "Oracle timed out before it captured a complete assistant response.",
      remediation: "Inspect or reattach to the saved session before retrying the same consult.",
      resumable: true,
      resumeCommand: reattachCommand(meta),
    });
  }

  if (stage === "connection-lost" || incompleteReason === "chrome-disconnected") {
    return blocker(meta, {
      kind: "browser_unavailable",
      severity: "retryable",
      message: "Oracle lost access to the browser before the session completed.",
      remediation: "Reattach to the saved browser session, or rerun after Chrome is reachable.",
      resumable: true,
      resumeCommand: reattachCommand(meta),
    });
  }

  if (stage === "cloudflare-challenge" || sourceMatches(text, [/cloudflare/, /captcha/])) {
    return blocker(meta, {
      kind: "captcha",
      severity: "action_required",
      message: "Oracle hit a browser challenge before it could continue.",
      remediation: "Complete the browser challenge in the Oracle profile, then retry the consult.",
      resumable: false,
    });
  }

  if (transportReason === "model-unavailable" || code === "model-option-unavailable") {
    return blocker(meta, {
      kind: "model_unavailable",
      severity: "action_required",
      message: "The requested model is not available through this Oracle engine or credential set.",
      remediation: "Select an available model, switch engines, or update the provider credentials.",
      resumable: false,
    });
  }

  if (transportReason === "unsupported-endpoint") {
    return blocker(meta, {
      kind: "unsupported_endpoint",
      severity: "action_required",
      message: "The configured API endpoint does not support Oracle's requested operation.",
      remediation:
        "Use a compatible OpenAI Responses API endpoint or switch to the browser engine.",
      resumable: false,
    });
  }

  if (code === "browser-unavailable") {
    return blocker(meta, {
      kind: "browser_unavailable",
      severity: "retryable",
      message: "Oracle could not reach the Open Browser Use bridge for main Chrome.",
      remediation:
        "Restore the main-Chrome bridge, verify it with open-browser-use ping and open-browser-use info, then retry or reattach to the saved session.",
      resumable: false,
    });
  }

  if (code === "identity-unavailable") {
    return blocker(meta, {
      kind: "browser_unavailable",
      severity: "retryable",
      message: "Oracle could not verify the routed ChatGPT identity in main Chrome.",
      remediation:
        "Keep chatgpt.com open and retry after the page and Open Browser Use bridge are responsive; do not reauthenticate unless Oracle reports login_required.",
      resumable: false,
    });
  }

  if (code === "scope-mismatch" || stage === "chatgpt-scope") {
    return blocker(meta, {
      kind: "scope_mismatch",
      severity: "action_required",
      message: "ChatGPT did not stay in the requested project or thread scope.",
      remediation:
        "Use an accessible ChatGPT project/thread URL, refresh the Oracle profile login, and retry without falling back to root chat.",
      resumable: false,
    });
  }

  if (
    sourceMatches(text, [
      /\b429\b/,
      /rate limit/,
      /too many requests/,
      /quota exceeded/,
      /quota resets?/,
    ])
  ) {
    return blocker(meta, {
      kind: "rate_limit",
      severity: "retryable",
      message: "Oracle was blocked by provider rate or quota limits.",
      remediation:
        "Wait for the quota window to reset, reduce concurrency, or use another credential.",
      resumable: false,
    });
  }

  if (
    sourceMatches(text, [
      /\b403\b/,
      /forbidden/,
      /unauthorized/,
      /permission/,
      /access denied/,
      /account blocked/,
      /does not have access/,
    ])
  ) {
    return blocker(meta, {
      kind: "permission",
      severity: "action_required",
      message: "Oracle does not have permission to complete the requested operation.",
      remediation:
        "Use an account or credential with access, or choose a supported model/workspace.",
      resumable: false,
    });
  }

  if (
    code === "login-required" &&
    (stage === "assistant-recheck" ||
      readErrorStringDetail(meta, "sessionStatus") === "needs_login")
  ) {
    const expectedEmail = readErrorStringDetail(meta, "expectedEmail")?.trim() ?? "";
    const expectedWorkspace = readErrorStringDetail(meta, "expectedWorkspace")?.trim() ?? "";
    const routedIdentity = expectedEmail
      ? `${expectedEmail}${expectedWorkspace ? ` / ${expectedWorkspace}` : ""}`
      : "the routed ChatGPT account";
    const resumeCommand = meta.id ? `oracle session ${meta.id} --render` : undefined;
    return blocker(meta, {
      kind: "login_required",
      severity: "action_required",
      message: `${routedIdentity} expired after Oracle submitted the prompt.`,
      remediation: resumeCommand
        ? `In main Chrome, sign back in to ${routedIdentity}, then run ${resumeCommand} to resume the existing conversation without buying another turn.`
        : `In main Chrome, sign back in to ${routedIdentity}, then resume the existing conversation without buying another turn.`,
      resumable: true,
      resumeCommand,
    });
  }

  if (
    code === "login-required" ||
    code === "workspace-required" ||
    sourceMatches(text, [
      /sign in/,
      /log in/,
      /logged out/,
      /login required/,
      /not signed in/,
      /authentication required/,
    ])
  ) {
    const expectedEmail = readErrorStringDetail(meta, "expectedEmail")?.trim() ?? "";
    const expectedWorkspace = readErrorStringDetail(meta, "expectedWorkspace")?.trim() ?? "";
    const routedIdentity = expectedEmail
      ? `${expectedEmail}${expectedWorkspace ? ` / ${expectedWorkspace}` : ""}`
      : "Oracle's browser profile";
    return blocker(meta, {
      kind: "login_required",
      severity: "action_required",
      message: `${routedIdentity} is not available in main Chrome.`,
      remediation: expectedEmail
        ? `In main Chrome, sign in to ${expectedEmail}${expectedWorkspace ? ` and select the “${expectedWorkspace}” workspace` : ""}, then retry the consult.`
        : "Sign in through Oracle's browser profile, then retry the consult.",
      resumable: false,
    });
  }

  if (
    code === "prompt-not-accepted" ||
    code === "model-selector-missing" ||
    (stage === "execute-browser" &&
      sourceMatches(text, [
        /selector/,
        /locator/,
        /data-testid/,
        /prompt composer/,
        /model picker/,
      ]))
  ) {
    return blocker(meta, {
      kind: "selector_drift",
      severity: "action_required",
      message: "Oracle browser automation could not find an expected ChatGPT UI element.",
      remediation: "Inspect the ChatGPT DOM and update the browser automation selector.",
      resumable: false,
    });
  }

  if (
    sourceMatches(text, [
      /selector/,
      /locator/,
      /data-testid/,
      /prompt textarea/,
      /prompt composer/,
      /model picker/,
      /element .*not found/,
      /button .*not found/,
      /unable to find/,
    ])
  ) {
    return blocker(meta, {
      kind: "selector_drift",
      severity: "action_required",
      message: "Oracle browser automation could not find an expected ChatGPT UI element.",
      remediation: "Inspect the ChatGPT DOM and update the browser automation selector.",
      resumable: false,
    });
  }

  if (meta.status === "error") {
    return blocker(meta, {
      kind: "unknown",
      severity: "unknown",
      message:
        meta.errorMessage ?? meta.error?.message ?? "Oracle failed without a classified blocker.",
      remediation: "Inspect the session log and metadata before retrying.",
      resumable: false,
    });
  }

  return undefined;
}
