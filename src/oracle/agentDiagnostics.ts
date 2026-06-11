import type { SessionMetadata } from "../sessionStore.js";

export type OracleAgentBlockerKind =
  | "login_required"
  | "captcha"
  | "permission"
  | "rate_limit"
  | "selector_drift"
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
  };
}

export interface AgentBlockerOptions {
  logTail?: string | null;
}

function readErrorStage(meta: SessionMetadata): string | undefined {
  const stage = meta.error?.details?.stage;
  return typeof stage === "string" ? stage : undefined;
}

function baseEvidence(meta: SessionMetadata): OracleAgentBlocker["evidence"] {
  const stage = readErrorStage(meta);
  return {
    sessionId: meta.id,
    status: meta.status,
    mode: meta.mode,
    incompleteReason: meta.response?.incompleteReason,
    transportReason: meta.transport?.reason,
    errorCategory: meta.error?.category,
    errorStage: stage,
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

  if (transportReason === "model-unavailable") {
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
    sourceMatches(text, [
      /sign in/,
      /log in/,
      /logged out/,
      /login required/,
      /not signed in/,
      /authentication required/,
    ])
  ) {
    return blocker(meta, {
      kind: "login_required",
      severity: "action_required",
      message: "Oracle's browser profile is not signed in.",
      remediation: "Sign in through Oracle's browser profile, then retry the consult.",
      resumable: false,
    });
  }

  if (
    stage === "execute-browser" &&
    sourceMatches(text, [/selector/, /locator/, /data-testid/, /prompt composer/, /model picker/])
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
