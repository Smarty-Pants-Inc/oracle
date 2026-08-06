import type { PromptCommitVerification } from "./actions/promptCommitVerification.js";
import { promptIdentitySha256 } from "./actions/committedPrompt.js";
import type { BrowserLogger } from "./types.js";

export type DomEvaluate = <T>(expression: string) => Promise<T | undefined>;
export type PromptCommitEvidence =
  | { status: "committed"; verification: PromptCommitVerification }
  | { status: "attempted" };
export interface PendingPromptEpochAuthority {
  promptSha256: string;
  baselineTurns: number;
  conversationId?: string;
}

export interface PendingPromptTurnObservation {
  role: "user" | "assistant";
  text: string;
  turnId: string | null;
  messageId: string | null;
}

export interface PendingPromptObservation {
  ready: boolean;
  conversationId: string | null;
  composerText: string;
  canSubmit: boolean;
  active: boolean;
  turns: PendingPromptTurnObservation[];
}

export type PendingPromptEpochReconciliation =
  | { status: "committed"; verification: PromptCommitVerification; prompt: string }
  | { status: "not-committed" }
  | { status: "ambiguous"; reason: string };

export type PendingPromptReconciliationContext = Pick<
  ProviderDomFlowContext,
  "evaluate" | "delay" | "log" | "state"
>;

export interface ProviderDomFlowContext {
  prompt: string;
  evaluate: DomEvaluate;
  delay: (ms: number) => Promise<void>;
  log?: BrowserLogger;
  state?: Record<string, unknown>;
}

export interface ProviderDomResponse {
  text: string;
  html?: string;
  meta?: { turnId?: string | null; messageId?: string | null };
}

export interface ProviderDomAdapter {
  providerName: string;
  waitForUi: (ctx: ProviderDomFlowContext) => Promise<void>;
  selectMode?: (ctx: ProviderDomFlowContext) => Promise<void>;
  typePrompt: (ctx: ProviderDomFlowContext) => Promise<void>;
  submitPrompt: (ctx: ProviderDomFlowContext) => Promise<PromptCommitEvidence>;
  reconcilePendingPrompt?: (
    ctx: PendingPromptReconciliationContext,
    authority: PendingPromptEpochAuthority,
  ) => Promise<PendingPromptEpochReconciliation>;
  waitForResponse: (ctx: ProviderDomFlowContext) => Promise<ProviderDomResponse>;
  extractThoughts?: (ctx: ProviderDomFlowContext) => Promise<string | null>;
}

export interface ProviderDomFlowResult extends ProviderDomResponse {
  thoughts: string | null;
}

export async function runProviderSubmissionFlow(
  adapter: ProviderDomAdapter,
  ctx: ProviderDomFlowContext,
): Promise<PromptCommitEvidence> {
  await adapter.waitForUi(ctx);
  if (adapter.selectMode) {
    await adapter.selectMode(ctx);
  }
  await adapter.typePrompt(ctx);
  return await adapter.submitPrompt(ctx);
}

export async function runProviderDomFlow(
  adapter: ProviderDomAdapter,
  ctx: ProviderDomFlowContext,
): Promise<ProviderDomFlowResult> {
  await runProviderSubmissionFlow(adapter, ctx);
  const response = await adapter.waitForResponse(ctx);
  const thoughts = adapter.extractThoughts ? await adapter.extractThoughts(ctx) : null;
  return { ...response, thoughts };
}

function committedPendingPrompt(
  observation: PendingPromptObservation,
  authority: PendingPromptEpochAuthority,
): PendingPromptEpochReconciliation | null {
  if (observation.turns.length < authority.baselineTurns) return null;
  const matches = observation.turns
    .map((turn, index) => ({ turn, index }))
    .filter(
      ({ turn, index }) =>
        index >= authority.baselineTurns &&
        turn.role === "user" &&
        promptIdentitySha256(turn.text) === authority.promptSha256,
    );
  if (matches.length !== 1) return null;
  const [{ turn, index }] = matches;
  if (!turn.turnId?.trim() || !turn.messageId?.trim()) {
    return { status: "ambiguous", reason: "The matching user turn has no stable identity." };
  }
  const duplicateTurnId = observation.turns.some(
    (candidate, candidateIndex) => candidateIndex !== index && candidate.turnId === turn.turnId,
  );
  const duplicateMessageId = observation.turns.some(
    (candidate, candidateIndex) =>
      candidateIndex !== index && candidate.messageId === turn.messageId,
  );
  if (duplicateTurnId || duplicateMessageId) {
    return { status: "ambiguous", reason: "The matching user turn identity is not unique." };
  }
  const conversationId = observation.conversationId?.trim();
  if (
    !conversationId ||
    (authority.conversationId && conversationId !== authority.conversationId)
  ) {
    return {
      status: "ambiguous",
      reason: "The matching user turn is not bound to the expected conversation.",
    };
  }
  return {
    status: "committed",
    prompt: turn.text,
    verification: {
      committedTurns: observation.turns.length,
      promptSha256: authority.promptSha256,
      verifiedUserTurnIndex: index,
      verifiedUserTurnId: turn.turnId.trim(),
      verifiedUserMessageId: turn.messageId.trim(),
      conversationId,
    },
  };
}
function sameObservedTurns(
  first: PendingPromptObservation,
  second: PendingPromptObservation,
): boolean {
  return (
    first.turns.length === second.turns.length &&
    first.turns.every((turn, index) => {
      const candidate = second.turns[index];
      return (
        candidate?.role === turn.role &&
        candidate.turnId === turn.turnId &&
        candidate.messageId === turn.messageId &&
        promptIdentitySha256(candidate.text) === promptIdentitySha256(turn.text)
      );
    })
  );
}

function sameCommittedObservation(
  first: PendingPromptEpochReconciliation | null,
  second: PendingPromptEpochReconciliation | null,
): second is Extract<PendingPromptEpochReconciliation, { status: "committed" }> {
  return (
    first?.status === "committed" &&
    second?.status === "committed" &&
    first.verification.promptSha256 === second.verification.promptSha256 &&
    first.verification.verifiedUserTurnIndex === second.verification.verifiedUserTurnIndex &&
    first.verification.verifiedUserTurnId === second.verification.verifiedUserTurnId &&
    first.verification.verifiedUserMessageId === second.verification.verifiedUserMessageId &&
    first.verification.conversationId === second.verification.conversationId
  );
}

export function reconcilePendingPromptObservations(
  first: PendingPromptObservation,
  second: PendingPromptObservation,
  authority: PendingPromptEpochAuthority,
): PendingPromptEpochReconciliation {
  const firstCommitted = committedPendingPrompt(first, authority);
  const secondCommitted = committedPendingPrompt(second, authority);
  if (sameCommittedObservation(firstCommitted, secondCommitted)) return secondCommitted;
  if (firstCommitted || secondCommitted) {
    return {
      status: "ambiguous",
      reason: "The matching user turn did not retain one exact stable identity.",
    };
  }
  if (!first.ready || !second.ready) {
    return { status: "ambiguous", reason: "The provider conversation is not fully hydrated." };
  }
  if (
    first.conversationId !== second.conversationId ||
    (authority.conversationId && second.conversationId !== authority.conversationId)
  ) {
    return { status: "ambiguous", reason: "Conversation authority changed during reconciliation." };
  }
  if (!sameObservedTurns(first, second)) {
    return { status: "ambiguous", reason: "Conversation turns changed during reconciliation." };
  }
  const stableEmptyEpoch = [first, second].every(
    (observation) =>
      observation.turns.length === authority.baselineTurns &&
      promptIdentitySha256(observation.composerText) === authority.promptSha256 &&
      observation.canSubmit &&
      !observation.active,
  );
  if (stableEmptyEpoch) return { status: "not-committed" };
  return {
    status: "ambiguous",
    reason: "The provider DOM cannot prove whether the pending prompt was submitted.",
  };
}

export function joinSelectors(selectors: readonly string[]): string {
  return selectors.join(", ");
}
