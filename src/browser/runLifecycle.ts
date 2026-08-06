import { randomUUID } from "node:crypto";
import type { BrowserPromptEpoch, BrowserRuntimeMetadata } from "../sessionManager.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { promptIdentitySha256 } from "./actions/committedPrompt.js";
import type { PromptCommitVerification } from "./actions/promptCommitVerification.js";
import type { PromptCommitEvidence } from "./providerDomFlow.js";
import type {
  BrowserCaptureFinalizationResult,
  BrowserRunResult,
  BrowserRunTransaction,
} from "./types.js";
import {
  OwnedBrowserResourceTransaction,
  type OwnedBrowserResourceTransactionAdapters,
} from "./ownedBrowserResources.js";

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
  | { kind: "published"; settlement: OwnedBrowserResourceTransaction };

export interface BrowserRunLifecycleAdapters extends OwnedBrowserResourceTransactionAdapters {
  getRuntime: () => BrowserRuntimeMetadata;
  onPromptCommitted?: () => void;
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
  | "promptSubmitted"
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
    promptSubmitted: runtime.promptEpoch?.status === "committed",
    controllerPid: runtime.controllerPid,
  };
}

export function createBrowserRunTransaction(
  result: BrowserRunResult,
  settlement: OwnedBrowserResourceTransaction,
): BrowserRunTransaction {
  const publishedRuntime = settlement.runtime();
  return {
    ...result,
    ...captureResultRuntime(publishedRuntime),
    get runtime() {
      return settlement.runtime();
    },
    bindSettlement: (mode) => settlement.bindSettlement(mode),
    finalize: () => settlement.settle("finalize"),
    abort: () => settlement.settle("abort"),
  };
}

export class BrowserRunLifecycleController {
  private state: BrowserRunLifecycleState = { kind: "acquiring" };
  private promptCommitPersistenceFailure: BrowserAutomationError | null = null;
  private promptResetPersistenceFailure: BrowserAutomationError | null = null;

  constructor(private readonly adapters: BrowserRunLifecycleAdapters) {}

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
    if (this.state.kind === "published") {
      return this.state.settlement.runtime().promptEpoch;
    }
    return undefined;
  }

  isPromptCommitted(): boolean {
    return this.promptEpoch()?.status === "committed";
  }

  hasPendingPromptAuthorityJournal(): boolean {
    return (
      this.promptCommitPersistenceFailure !== null || this.promptResetPersistenceFailure !== null
    );
  }

  runtime(base = this.adapters.getRuntime()): BrowserRuntimeMetadata {
    if (this.state.kind === "published") {
      return this.state.settlement.runtime();
    }
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
    const previousState = this.state;
    if (previousState.kind === "capturing" && this.promptCommitPersistenceFailure) {
      try {
        await this.persistRuntime();
        this.promptCommitPersistenceFailure = null;
      } catch (cause) {
        const persistenceFailure = this.promptAuthorityPersistenceError(cause);
        this.promptCommitPersistenceFailure = persistenceFailure;
        this.promptResetPersistenceFailure = persistenceFailure;
        throw persistenceFailure;
      }
    }
    this.state = { kind: "ready" };
    try {
      await this.persistRuntime();
      this.promptResetPersistenceFailure = null;
    } catch (cause) {
      this.state = previousState;
      const persistenceFailure = this.promptAuthorityPersistenceError(cause);
      if (previousState.kind === "capturing") {
        this.promptResetPersistenceFailure = persistenceFailure;
      }
      throw persistenceFailure;
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
      this.promptCommitPersistenceFailure = null;
    } catch (cause) {
      // Verification records an external post-effect fact. Capture must continue with the
      // exact committed authority in memory; a later reset retries this journal before send.
      this.promptCommitPersistenceFailure = this.promptAuthorityPersistenceError(cause);
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
    const settlement = new OwnedBrowserResourceTransaction(this.adapters, this.runtime(base));
    const publishedResult = this.promptCommitPersistenceFailure
      ? {
          ...result,
          warnings: [
            ...(result.warnings ?? []),
            {
              code: "prompt-commit-journal-pending",
              severity: "warning" as const,
              message:
                "The prompt commit journal failed after verified dispatch; exact committed authority is retained by this capture transaction.",
              details: {
                stage: this.promptCommitPersistenceFailure.details?.stage,
                code: this.promptCommitPersistenceFailure.details?.code,
              },
            },
          ],
        }
      : result;
    this.state = { kind: "published", settlement };
    return createBrowserRunTransaction(publishedResult, settlement);
  }

  /**
   * Publish a committed run's live resource authority for later recovery without settling it.
   * The recovery runtime becomes the external owner, so automatic unpublished abort must stop.
   */
  publishRecovery(base = this.adapters.getRuntime()): BrowserRuntimeMetadata {
    if (this.state.kind !== "capturing") {
      throw this.illegalTransition("publish committed recovery authority");
    }
    const settlement = new OwnedBrowserResourceTransaction(this.adapters, this.runtime(base));
    this.state = { kind: "published", settlement };
    return settlement.runtime();
  }

  async settleIfUnpublished(): Promise<BrowserCaptureFinalizationResult | null> {
    if (this.state.kind === "published") return null;
    const settlement = new OwnedBrowserResourceTransaction(
      this.adapters,
      this.runtime(this.adapters.getRuntime()),
    );
    this.state = { kind: "published", settlement };
    return settlement.settle("abort");
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
