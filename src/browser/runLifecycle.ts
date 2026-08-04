import { randomUUID } from "node:crypto";
import type { BrowserPromptEpoch, BrowserRuntimeMetadata } from "../sessionManager.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { promptIdentitySha256, type PromptCommitVerification } from "./actions/promptComposer.js";
import type { PromptCommitEvidence } from "./providerDomFlow.js";
import type {
  BrowserCaptureFinalizationResult,
  BrowserRunResult,
  BrowserRunTransaction,
} from "./types.js";

export type BrowserCaptureSettlementMode = "finalize" | "abort";

export interface PromptEpochIdentity {
  epochId: string;
  promptSha256: string;
}

export type BrowserPromptDispatchPhase =
  | { status: "idle" }
  | {
      status: "pending";
      epochId: string;
      prompt: string;
      promptSha256: string;
      baselineTurns: number;
      followUpOrdinal: number;
      remainingFollowUps: number;
    }
  | {
      status: "committed";
      epochId: string;
      promptSha256: string;
      baselineTurns: number;
      followUpOrdinal: number;
      remainingFollowUps: number;
      verification: PromptCommitVerification;
    };

export type BrowserRunLifecyclePhase =
  | { kind: "acquiring" }
  | { kind: "ready" }
  | { kind: "dispatching"; epoch: Extract<BrowserPromptEpoch, { status: "pending" }> }
  | { kind: "capturing"; epoch: Extract<BrowserPromptEpoch, { status: "committed" }> }
  | { kind: "caller-publication" }
  | { kind: "settling"; mode: BrowserCaptureSettlementMode }
  | { kind: "completed"; mode: BrowserCaptureSettlementMode }
  | { kind: "cleanup-pending"; mode: BrowserCaptureSettlementMode; error: string };

interface PendingDispatch {
  epochId: string;
  prompt: string;
  promptSha256: string;
  baselineTurns: number;
  followUpOrdinal: number;
  remainingFollowUps: number;
}

interface CommittedDispatch extends PendingDispatch {
  verification: PromptCommitVerification;
}

type BrowserRunLifecycleState =
  | { kind: "acquiring" }
  | { kind: "ready" }
  | { kind: "dispatching"; dispatch: PendingDispatch }
  | { kind: "capturing"; dispatch: CommittedDispatch }
  | { kind: "caller-publication"; runtime: BrowserRuntimeMetadata }
  | {
      kind: "settling";
      mode: BrowserCaptureSettlementMode;
      runtime: BrowserRuntimeMetadata;
      completion: Promise<BrowserCaptureFinalizationResult>;
    }
  | {
      kind: "completed";
      mode: BrowserCaptureSettlementMode;
      result: Extract<BrowserCaptureFinalizationResult, { status: "completed" }>;
    }
  | {
      kind: "cleanup-pending";
      mode: BrowserCaptureSettlementMode;
      result: Extract<BrowserCaptureFinalizationResult, { status: "pending" }>;
    };

export interface BrowserRunLifecycleAdapters {
  getRuntime: () => BrowserRuntimeMetadata;
  persistRuntime?: (runtime: BrowserRuntimeMetadata) => Promise<void>;
  settleResources: (
    mode: BrowserCaptureSettlementMode,
    pendingRuntime: BrowserRuntimeMetadata,
  ) => Promise<BrowserCaptureFinalizationResult>;
  onPromptCommitted?: () => void;
}

export function markBrowserCaptureCleanupPending(
  runtime: BrowserRuntimeMetadata,
  settlementMode?: BrowserCaptureSettlementMode,
): BrowserRuntimeMetadata {
  const hasCleanupAuthority = Boolean(
    runtime.recoveryCleanupResources?.length ||
    runtime.recoveryCleanupResult ||
    runtime.remoteRecovery,
  );
  if (!hasCleanupAuthority) return runtime;
  return {
    ...runtime,
    recoveryCleanupResult: {
      status: "pending",
      ...(settlementMode ? { settlementMode } : {}),
    },
  };
}

export function completedBrowserCaptureCleanup(
  runtime: BrowserRuntimeMetadata,
): BrowserCaptureFinalizationResult {
  const completed = { ...runtime };
  delete completed.recoveryCleanupResources;
  delete completed.recoveryCleanupResult;
  delete completed.remoteRecovery;
  return { status: "completed", runtime: completed };
}

export function pendingBrowserCaptureCleanup(
  runtime: BrowserRuntimeMetadata,
  error: string,
  settlementMode?: BrowserCaptureSettlementMode,
): BrowserCaptureFinalizationResult {
  const hasCleanupAuthority = Boolean(
    runtime.recoveryCleanupResources?.length ||
    runtime.recoveryCleanupResult ||
    runtime.remoteRecovery,
  );
  return {
    status: "pending",
    runtime: hasCleanupAuthority
      ? {
          ...runtime,
          recoveryCleanupResult: {
            status: "failed",
            error,
            ...(settlementMode ? { settlementMode } : {}),
          },
        }
      : runtime,
    error,
  };
}

export function bindBrowserCaptureCleanupSettlement(
  result: BrowserCaptureFinalizationResult,
  settlementMode: BrowserCaptureSettlementMode,
): BrowserCaptureFinalizationResult {
  if (result.status === "completed") return result;
  const hasCleanupAuthority = Boolean(
    result.runtime.recoveryCleanupResources?.length ||
    result.runtime.recoveryCleanupResult ||
    result.runtime.remoteRecovery,
  );
  if (!hasCleanupAuthority) return result;
  const cleanupResult = result.runtime.recoveryCleanupResult;
  return {
    ...result,
    runtime: {
      ...result.runtime,
      recoveryCleanupResult: {
        status: cleanupResult?.status ?? "failed",
        error: cleanupResult?.error ?? result.error,
        settlementMode,
      },
    },
  };
}

function pendingPromptEpoch(
  dispatch: PendingDispatch,
): Extract<BrowserPromptEpoch, { status: "pending" }> {
  return {
    status: "pending",
    epochId: dispatch.epochId,
    promptSha256: dispatch.promptSha256,
    baselineTurns: dispatch.baselineTurns,
    followUpOrdinal: dispatch.followUpOrdinal,
    remainingFollowUps: dispatch.remainingFollowUps,
  };
}

function committedPromptEpoch(
  dispatch: CommittedDispatch,
): Extract<BrowserPromptEpoch, { status: "committed" }> {
  return {
    ...pendingPromptEpoch(dispatch),
    status: "committed",
    verifiedUserTurnIndex: dispatch.verification.verifiedUserTurnIndex,
    verifiedUserTurnId: dispatch.verification.verifiedUserTurnId,
    verifiedUserMessageId: dispatch.verification.verifiedUserMessageId,
    conversationId: dispatch.verification.conversationId,
  };
}

function captureResultRuntime(
  runtime: BrowserRuntimeMetadata,
): Pick<
  BrowserRunResult,
  | "browserTransport"
  | "chromePid"
  | "chromeProcessIdentity"
  | "chromePort"
  | "chromeHost"
  | "chromeBrowserWSEndpoint"
  | "chromeProfileRoot"
  | "userDataDir"
  | "chromeTargetId"
  | "tabUrl"
  | "conversationId"
  | "promptEpoch"
  | "controllerPid"
> {
  return {
    browserTransport: runtime.browserTransport,
    chromePid: runtime.chromePid,
    chromeProcessIdentity: runtime.chromeProcessIdentity,
    chromePort: runtime.chromePort,
    chromeHost: runtime.chromeHost,
    chromeBrowserWSEndpoint: runtime.chromeBrowserWSEndpoint,
    chromeProfileRoot: runtime.chromeProfileRoot,
    userDataDir: runtime.userDataDir,
    chromeTargetId: runtime.chromeTargetId,
    tabUrl: runtime.tabUrl,
    conversationId: runtime.conversationId,
    promptEpoch: runtime.promptEpoch,
    controllerPid: runtime.controllerPid,
  };
}

export class BrowserRunLifecycleController {
  private state: BrowserRunLifecycleState = { kind: "acquiring" };

  constructor(private readonly adapters: BrowserRunLifecycleAdapters) {}

  phase(): BrowserRunLifecyclePhase {
    switch (this.state.kind) {
      case "acquiring":
      case "ready":
        return { kind: this.state.kind };
      case "dispatching":
        return { kind: "dispatching", epoch: pendingPromptEpoch(this.state.dispatch) };
      case "capturing":
        return { kind: "capturing", epoch: committedPromptEpoch(this.state.dispatch) };
      case "caller-publication":
        return { kind: "caller-publication" };
      case "settling":
        return { kind: "settling", mode: this.state.mode };
      case "completed":
        return { kind: "completed", mode: this.state.mode };
      case "cleanup-pending":
        return { kind: "cleanup-pending", mode: this.state.mode, error: this.state.result.error };
    }
  }

  markAcquired(): void {
    if (this.state.kind !== "acquiring") {
      throw this.illegalTransition("mark acquisition complete");
    }
    this.state = { kind: "ready" };
  }

  promptDispatch(): BrowserPromptDispatchPhase {
    if (this.state.kind === "dispatching") {
      return { status: "pending", ...this.state.dispatch };
    }
    if (this.state.kind === "capturing") {
      const { prompt: _prompt, ...dispatch } = this.state.dispatch;
      return { status: "committed", ...dispatch };
    }
    return { status: "idle" };
  }

  promptEpoch(): BrowserPromptEpoch | undefined {
    if (this.state.kind === "dispatching") {
      return pendingPromptEpoch(this.state.dispatch);
    }
    if (this.state.kind === "capturing") {
      return committedPromptEpoch(this.state.dispatch);
    }
    if (this.state.kind === "caller-publication" || this.state.kind === "settling") {
      return this.state.runtime.promptEpoch;
    }
    if (this.state.kind === "completed" || this.state.kind === "cleanup-pending") {
      return this.state.result.runtime.promptEpoch;
    }
    return undefined;
  }

  isPromptCommitted(): boolean {
    return this.promptEpoch()?.status === "committed";
  }

  runtime(base = this.adapters.getRuntime()): BrowserRuntimeMetadata {
    const epoch = this.promptEpoch();
    const conversationId =
      base.conversationId ?? (epoch?.status === "committed" ? epoch.conversationId : undefined);
    return {
      ...base,
      conversationId,
      promptEpoch: epoch,
      recoveryCleanupResources: base.recoveryCleanupResources?.map((resource) => ({
        ...resource,
        conversationId,
        promptEpoch: epoch,
      })),
    };
  }

  async resetPrompt(): Promise<void> {
    if (
      this.state.kind !== "ready" &&
      this.state.kind !== "dispatching" &&
      this.state.kind !== "capturing"
    ) {
      throw this.illegalTransition("reset prompt authority");
    }
    this.state = { kind: "ready" };
    try {
      await this.persistRuntime();
    } catch (cause) {
      throw this.promptAuthorityPersistenceError(cause);
    }
  }

  async beginPromptDispatch(
    prompt: string,
    baselineTurns: number,
    followUpOrdinal: number,
    remainingFollowUps: number,
  ): Promise<PromptEpochIdentity> {
    if (this.state.kind !== "ready") {
      throw this.illegalTransition("begin prompt dispatch");
    }
    if (
      !Number.isInteger(baselineTurns) ||
      baselineTurns < 0 ||
      !Number.isInteger(followUpOrdinal) ||
      followUpOrdinal < 0 ||
      !Number.isInteger(remainingFollowUps) ||
      remainingFollowUps < 0
    ) {
      throw new BrowserAutomationError("Prompt epoch counters must be nonnegative integers.", {
        stage: "prompt-epoch",
        code: "prompt-epoch-invalid",
      });
    }
    const dispatch: PendingDispatch = {
      epochId: randomUUID(),
      prompt,
      promptSha256: promptIdentitySha256(prompt),
      baselineTurns,
      followUpOrdinal,
      remainingFollowUps,
    };
    this.state = { kind: "dispatching", dispatch };
    try {
      await this.persistRuntime();
    } catch (cause) {
      throw this.promptAuthorityPersistenceError(cause);
    }
    return { epochId: dispatch.epochId, promptSha256: dispatch.promptSha256 };
  }

  async recordPromptCommitVerification(
    verification: PromptCommitVerification,
    expected: PromptEpochIdentity,
  ): Promise<void> {
    if (this.state.kind !== "dispatching") {
      throw this.promptEpochMismatch();
    }
    const pending = this.state.dispatch;
    if (
      pending.epochId !== expected.epochId ||
      pending.promptSha256 !== expected.promptSha256 ||
      verification.promptSha256 !== pending.promptSha256 ||
      !Number.isInteger(verification.verifiedUserTurnIndex) ||
      verification.verifiedUserTurnIndex < pending.baselineTurns ||
      !Number.isInteger(verification.committedTurns) ||
      verification.committedTurns <= verification.verifiedUserTurnIndex ||
      typeof verification.verifiedUserTurnId !== "string" ||
      !verification.verifiedUserTurnId.trim() ||
      typeof verification.verifiedUserMessageId !== "string" ||
      !verification.verifiedUserMessageId.trim() ||
      typeof verification.conversationId !== "string" ||
      !verification.conversationId.trim()
    ) {
      throw this.promptEpochMismatch();
    }
    this.state = { kind: "capturing", dispatch: { ...pending, verification } };
    try {
      await this.persistRuntime();
    } catch (cause) {
      this.state = { kind: "dispatching", dispatch: pending };
      throw this.promptAuthorityPersistenceError(cause);
    }
    this.adapters.onPromptCommitted?.();
  }

  async recordPromptCommitEvidence(
    evidence: PromptCommitEvidence,
    expected: PromptEpochIdentity,
  ): Promise<void> {
    if (evidence.status !== "committed") return;
    if (!evidence.verification) {
      throw new BrowserAutomationError(
        "Prompt provider reported a commit without current-turn verification.",
        { stage: "prompt-epoch", code: "prompt-epoch-evidence-missing" },
      );
    }
    await this.recordPromptCommitVerification(evidence.verification, expected);
  }

  issueCapture(result: BrowserRunResult, base = this.adapters.getRuntime()): BrowserRunTransaction {
    if (this.state.kind !== "capturing") {
      throw this.illegalTransition("issue captured result for caller publication");
    }
    const pendingRuntime = markBrowserCaptureCleanupPending(this.runtime(base));
    this.state = { kind: "caller-publication", runtime: pendingRuntime };
    return {
      ...result,
      ...captureResultRuntime(pendingRuntime),
      runtime: pendingRuntime,
      finalize: () => this.settlePublishedCapture("finalize"),
      abort: () => this.settlePublishedCapture("abort"),
    };
  }

  async settleIfUnpublished(): Promise<BrowserCaptureFinalizationResult | null> {
    if (
      this.state.kind === "caller-publication" ||
      this.state.kind === "settling" ||
      this.state.kind === "completed" ||
      this.state.kind === "cleanup-pending"
    ) {
      return null;
    }
    return this.beginSettlement(
      "finalize",
      markBrowserCaptureCleanupPending(this.runtime(this.adapters.getRuntime())),
    );
  }

  private settlePublishedCapture(
    mode: BrowserCaptureSettlementMode,
  ): Promise<BrowserCaptureFinalizationResult> {
    if (this.state.kind === "caller-publication") {
      return this.beginSettlement(mode, this.state.runtime);
    }
    if (this.state.kind === "settling") {
      if (this.state.mode !== mode) {
        return Promise.reject(this.settlementModeConflict(mode, this.state.mode));
      }
      return this.state.completion;
    }
    if (this.state.kind === "cleanup-pending") {
      if (this.state.mode !== mode) {
        return Promise.reject(this.settlementModeConflict(mode, this.state.mode));
      }
      return this.beginSettlement(mode, this.state.result.runtime);
    }
    if (this.state.kind === "completed") {
      if (this.state.mode !== mode) {
        return Promise.reject(this.settlementModeConflict(mode, this.state.mode));
      }
      return Promise.resolve(this.state.result);
    }
    return Promise.reject(this.illegalTransition(`settle published capture (${mode})`));
  }

  private beginSettlement(
    mode: BrowserCaptureSettlementMode,
    runtime: BrowserRuntimeMetadata,
  ): Promise<BrowserCaptureFinalizationResult> {
    const boundRuntime = markBrowserCaptureCleanupPending(runtime, mode);
    const completion = Promise.resolve()
      .then(async () => {
        await this.adapters.persistRuntime?.(boundRuntime);
        return this.adapters.settleResources(mode, boundRuntime);
      })
      .catch((error) =>
        pendingBrowserCaptureCleanup(
          boundRuntime,
          error instanceof Error ? error.message : String(error),
          mode,
        ),
      )
      .then((result) => {
        const boundResult = bindBrowserCaptureCleanupSettlement(result, mode);
        this.state =
          boundResult.status === "completed"
            ? { kind: "completed", mode, result: boundResult }
            : { kind: "cleanup-pending", mode, result: boundResult };
        return boundResult;
      });
    this.state = { kind: "settling", mode, runtime: boundRuntime, completion };
    return completion;
  }

  private async persistRuntime(): Promise<void> {
    await this.adapters.persistRuntime?.(this.runtime());
  }

  private promptAuthorityPersistenceError(cause: unknown): BrowserAutomationError {
    return new BrowserAutomationError(
      "Failed to durably persist current prompt authority.",
      {
        stage: "prompt-epoch-persistence",
        code: "prompt-epoch-persistence-failed",
        runtime: this.runtime(),
      },
      cause,
    );
  }

  private promptEpochMismatch(): BrowserAutomationError {
    return new BrowserAutomationError(
      "Prompt commit evidence does not belong to the current prompt epoch.",
      { stage: "prompt-epoch", code: "prompt-epoch-mismatch" },
    );
  }

  private settlementModeConflict(
    requestedMode: BrowserCaptureSettlementMode,
    boundMode: BrowserCaptureSettlementMode,
  ): BrowserAutomationError {
    return new BrowserAutomationError(
      `Browser run transaction is already bound to ${boundMode}; ${requestedMode} is not allowed.`,
      {
        stage: "browser-run-lifecycle",
        code: "browser-run-lifecycle-settlement-conflict",
        phase: this.state.kind,
        requestedMode,
        boundMode,
      },
    );
  }

  private illegalTransition(action: string): BrowserAutomationError {
    return new BrowserAutomationError(
      `Browser run lifecycle cannot ${action} while in the ${this.state.kind} phase.`,
      {
        stage: "browser-run-lifecycle",
        code: "browser-run-lifecycle-transition-invalid",
        phase: this.state.kind,
        action,
      },
    );
  }
}
