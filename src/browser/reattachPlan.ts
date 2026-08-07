import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { resolveGeminiWebModel } from "../gemini-web/models.js";
import { requireCommittedPromptEpochLocator } from "./reattachAcquisition.js";
import {
  findRemoteRecoveryAuthority,
  hasPendingPromptEpoch,
  resolveCommittedGeminiPromptEpochLocator,
  resolvePendingPromptEpochAuthority,
} from "./reattachability.js";
import type {
  CommittedPromptEpochLocator,
  PendingPromptEpochAuthority,
} from "./reattachability.js";
import { selectPendingPromptTarget, selectTarget } from "./reattachTargetSelection.js";
import type { ExplicitTargetSelectionFailure, TargetSelection } from "./reattachTargetSelection.js";
import type { TargetInfoLite } from "./reattachHelpers.js";

export type ReattachRecoveryClassification = "stale-runtime" | "recoverable-transport";

export type ReattachCaptureKind = "gemini" | "chatgpt";

export type ReattachPlan =
  | { kind: "remote"; promptLocator: CommittedPromptEpochLocator | null }
  | { kind: "pending-prompt"; authority: PendingPromptEpochAuthority; capture: ReattachCaptureKind }
  | { kind: "committed-gemini"; promptLocator: CommittedPromptEpochLocator }
  | { kind: "committed-chatgpt"; promptLocator: CommittedPromptEpochLocator };

export class ClassifiedReattachError extends Error {
  readonly classification: ReattachRecoveryClassification;

  constructor(classification: ReattachRecoveryClassification, message: string, cause?: unknown) {
    super(message);
    this.name = "ClassifiedReattachError";
    this.classification = classification;
    if (cause) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export function explicitTargetAuthorityError(
  browserTabRef: string,
  failure: ExplicitTargetSelectionFailure | "runtime-unavailable" | "attach-failed",
  message: string,
  cause?: unknown,
): BrowserAutomationError {
  return new BrowserAutomationError(
    message,
    {
      stage: "browser-reattach-explicit-target",
      code: `explicit-browser-tab-${failure}`,
      browserTabRef,
      reattachClassification: "explicit-selector-terminal",
    },
    cause,
  );
}

export function isExplicitTargetAuthorityError(error: unknown): error is BrowserAutomationError {
  return (
    error instanceof BrowserAutomationError &&
    error.details?.reattachClassification === "explicit-selector-terminal"
  );
}

export async function classifyReattachFailure<T>(
  classification: ReattachRecoveryClassification,
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BrowserAutomationError || error instanceof ClassifiedReattachError) {
      throw error;
    }
    throw new ClassifiedReattachError(classification, message, error);
  }
}

export function isGeminiAppUrl(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    return (
      url.protocol === "https:" &&
      !url.port &&
      url.hostname === "gemini.google.com" &&
      (url.pathname === "/app" || url.pathname.startsWith("/app/"))
    );
  } catch {
    return false;
  }
}

function selectGeminiRecoveryTarget(
  targets: TargetInfoLite[],
  runtime: BrowserRuntimeMetadata,
  browserTabRef?: string,
): TargetSelection {
  const targetIds = new Set(
    [
      runtime.chromeTargetId,
      ...(runtime.recoveryCleanupResources ?? []).map((resource) => resource.chromeTargetId),
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0),
  );
  if (targetIds.size !== 1) {
    return { status: targetIds.size > 1 ? "ambiguous" : "missing" };
  }
  const targetId = targetIds.values().next().value;
  if (!targetId) return { status: "missing" };
  if (
    runtime.promptEpoch?.status !== "committed" ||
    runtime.promptEpoch.conversationId !== targetId
  ) {
    return { status: "mismatched" };
  }
  const exactTargets = targets.filter((target) => (target.targetId ?? target.id) === targetId);
  if (exactTargets.length !== 1) {
    return { status: exactTargets.length > 1 ? "ambiguous" : "missing" };
  }
  const target = exactTargets[0];
  if (target.type && target.type !== "page") return { status: "mismatched" };
  if (!isGeminiAppUrl(target.url)) return { status: "mismatched" };
  if (browserTabRef) {
    if (browserTabRef.toLowerCase() === "current") return { status: "unsupported" };
    if (browserTabRef !== targetId && browserTabRef !== target.url) return { status: "mismatched" };
  }
  return { status: "selected", target, targetId };
}

export function pendingPromptRecoveryError(
  runtime: BrowserRuntimeMetadata,
  reason: string,
): BrowserAutomationError {
  return new BrowserAutomationError(`Pending prompt epoch recovery remains ambiguous: ${reason}`, {
    stage: "prompt-epoch-reconciliation",
    code: "pending-prompt-epoch-ambiguous",
    reattachable: true,
    recoverableDisconnect: true,
    runtime,
  });
}

function requireReattachPromptLocator(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  capture: ReattachCaptureKind,
): CommittedPromptEpochLocator {
  if (capture === "chatgpt") return requireCommittedPromptEpochLocator(runtime);
  const locator = resolveCommittedGeminiPromptEpochLocator(runtime, config);
  if (locator) return locator;
  throw new BrowserAutomationError(
    "Gemini reattach requires immutable committed-prompt identity and an exact retained target binding.",
    {
      stage: "gemini-response-capture",
      code: "gemini-reattach-authority-unavailable",
      reattachable: false,
      runtime,
    },
  );
}

export function createCommittedReattachPlan(
  capture: ReattachCaptureKind,
  promptLocator: CommittedPromptEpochLocator,
): Extract<ReattachPlan, { kind: "committed-gemini" | "committed-chatgpt" }> {
  return capture === "gemini"
    ? { kind: "committed-gemini", promptLocator }
    : { kind: "committed-chatgpt", promptLocator };
}

export function reattachCaptureKind(config: BrowserSessionConfig | undefined): ReattachCaptureKind {
  return resolveGeminiWebModel(config?.desiredModel) === "gemini-3-pro-deep-think"
    ? "gemini"
    : "chatgpt";
}

export function createReattachPlan(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  sessionId: string | undefined,
  capture: ReattachCaptureKind,
): ReattachPlan {
  const explicitTabRef = config?.browserTabRef?.trim() || undefined;
  const remote = findRemoteRecoveryAuthority(runtime);
  if (remote) {
    if (explicitTabRef) {
      throw explicitTargetAuthorityError(
        explicitTabRef,
        "unsupported",
        `Explicit browser tab ${explicitTabRef} cannot be combined with remote transaction recovery because the remote protocol cannot carry exact tab authority.`,
      );
    }
    return {
      kind: "remote",
      promptLocator:
        runtime.promptEpoch?.status === "committed"
          ? requireReattachPromptLocator(runtime, config, capture)
          : null,
    };
  }
  if (hasPendingPromptEpoch(runtime) && !sessionId?.trim()) {
    throw pendingPromptRecoveryError(runtime, "the exact recovering session owner is unavailable");
  }
  const authority = resolvePendingPromptEpochAuthority(runtime, sessionId?.trim());
  if (authority) return { kind: "pending-prompt", authority, capture };
  if (hasPendingPromptEpoch(runtime)) {
    throw pendingPromptRecoveryError(
      runtime,
      "the persisted pending epoch lacks exact retained target authority",
    );
  }
  if (runtime.promptEpoch?.status !== "committed") {
    throw new BrowserAutomationError("Local browser reattach requires a committed prompt epoch.", {
      stage: "prompt-epoch",
      code: "committed-prompt-identity-mismatch",
    });
  }
  return createCommittedReattachPlan(
    capture,
    requireReattachPromptLocator(runtime, config, capture),
  );
}

export function assertSamePendingPromptAuthority(
  expected: PendingPromptEpochAuthority,
  actual: PendingPromptEpochAuthority | null,
  runtime: BrowserRuntimeMetadata,
): asserts actual is PendingPromptEpochAuthority {
  if (
    !actual ||
    actual.targetId !== expected.targetId ||
    actual.epoch.epochId !== expected.epoch.epochId ||
    actual.epoch.promptSha256 !== expected.epoch.promptSha256 ||
    actual.epoch.baselineTurns !== expected.epoch.baselineTurns ||
    actual.epoch.followUpOrdinal !== expected.epoch.followUpOrdinal ||
    actual.epoch.remainingFollowUps !== expected.epoch.remainingFollowUps ||
    actual.conversationId !== expected.conversationId ||
    actual.resourceKey !== expected.resourceKey
  ) {
    throw pendingPromptRecoveryError(runtime, "persisted target or prompt authority changed");
  }
}

export function selectReattachPlanTarget(
  plan: Exclude<ReattachPlan, { kind: "remote" }>,
  targets: TargetInfoLite[],
  runtime: BrowserRuntimeMetadata,
  browserTabRef?: string,
): TargetSelection {
  if (plan.kind === "pending-prompt") {
    return selectPendingPromptTarget(targets, plan.authority.targetId, browserTabRef);
  }
  if (plan.kind === "committed-gemini") {
    return selectGeminiRecoveryTarget(targets, runtime, browserTabRef);
  }
  return selectTarget(targets, runtime, browserTabRef);
}
export function reattachPlanPromptLocator(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  capture: ReattachCaptureKind,
): CommittedPromptEpochLocator {
  return requireReattachPromptLocator(runtime, config, capture);
}
