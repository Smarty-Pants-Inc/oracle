import { promptIdentitySha256 } from "../actions/committedPrompt.js";
import type { CommittedPromptEpochLocator } from "../reattachability.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import type {
  PendingPromptEpochAuthority,
  PendingPromptEpochReconciliation,
  PendingPromptObservation,
  PendingPromptReconciliationContext,
} from "../providerDomFlow.js";
import { reconcilePendingPromptObservations } from "../providerDomFlow.js";
import {
  geminiResponseIdentity,
  pairGeminiPromptAndAssistant,
  readGeminiConversationSnapshot,
  type GeminiConversationSnapshot,
  type GeminiConversationTurn,
} from "./geminiConversationSnapshot.js";
import type {
  GeminiDeepThinkDomFlowContext,
  GeminiDeepThinkDomProviderState,
  GeminiDeepThinkDomResponse,
} from "./geminiDeepThinkLive.js";
import { hasImmutableGeminiPromptIdentity } from "./geminiDeepThinkLive.js";

function isGeminiResponseTurn(
  entry: GeminiConversationTurn,
): entry is GeminiConversationTurn & { kind: "response" } {
  return entry.kind === "response";
}

function pendingObservationFromSnapshot(
  snapshot: GeminiConversationSnapshot,
  conversationId: string,
  authority: PendingPromptEpochAuthority,
): PendingPromptObservation | null {
  const matchingUsers = snapshot.entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry, index }) =>
        index >= authority.baselineTurns &&
        entry.kind === "user" &&
        promptIdentitySha256(entry.text) === authority.promptSha256,
    );
  if (matchingUsers.length === 1 && matchingUsers[0].entry.stableId) {
    const pairing = pairGeminiPromptAndAssistant(snapshot.entries, {
      userStableId: matchingUsers[0].entry.stableId,
      promptSha256: authority.promptSha256,
    });
    if (pairing.status === "unsupported" || pairing.status === "prompt-mismatch") return null;
  }

  return {
    ready: snapshot.ready,
    conversationId,
    composerText: snapshot.composerText,
    canSubmit: snapshot.canSubmit,
    active: snapshot.active,
    turns: snapshot.entries.map((entry) => {
      if (!isGeminiResponseTurn(entry)) {
        return {
          role: "user" as const,
          text: entry.text,
          turnId: entry.stableId,
          messageId: entry.stableId,
        };
      }
      const identity = geminiResponseIdentity(snapshot.entries, entry);
      const stableId = identity.status === "identified" ? identity.stableId : null;
      return {
        role: "assistant" as const,
        text: entry.text,
        turnId: stableId,
        messageId: stableId,
      };
    }),
  };
}

async function readPendingPromptObservation(
  ctx: PendingPromptReconciliationContext<GeminiDeepThinkDomProviderState>,
  authority: PendingPromptEpochAuthority,
): Promise<PendingPromptObservation | null> {
  const conversationId = ctx.state.geminiConversationId?.trim();
  if (!conversationId) return null;
  const snapshot = await readGeminiConversationSnapshot(ctx.evaluate);
  return snapshot ? pendingObservationFromSnapshot(snapshot, conversationId, authority) : null;
}

export async function reconcilePendingGeminiDeepThinkPrompt(
  ctx: PendingPromptReconciliationContext<GeminiDeepThinkDomProviderState>,
  authority: PendingPromptEpochAuthority,
): Promise<PendingPromptEpochReconciliation> {
  const first = await readPendingPromptObservation(ctx, authority);
  await ctx.delay(750);
  const second = await readPendingPromptObservation(ctx, authority);
  if (!first || !second) {
    return {
      status: "ambiguous",
      reason: "Gemini prompt reconciliation returned invalid DOM state.",
    };
  }
  return reconcilePendingPromptObservations(first, second, authority);
}

export async function recoverCommittedGeminiDeepThinkResponse(
  ctx: Pick<GeminiDeepThinkDomFlowContext, "evaluate" | "delay" | "log">,
  promptLocator: CommittedPromptEpochLocator,
  timeoutMs: number,
): Promise<GeminiDeepThinkDomResponse> {
  if (!hasImmutableGeminiPromptIdentity(promptLocator)) {
    throw new BrowserAutomationError(
      "Committed Gemini prompt lacks an immutable provider user identity for exact reattach.",
      {
        stage: "prompt-epoch",
        code: "gemini-reattach-authority-unavailable",
        reattachable: false,
      },
    );
  }
  const authority = {
    userStableId: promptLocator.verifiedUserTurnId.trim(),
    promptSha256: promptLocator.promptSha256,
  };
  const deadline = Date.now() + Math.max(1_000, timeoutMs);

  while (Date.now() < deadline) {
    const snapshot = await readGeminiConversationSnapshot(ctx.evaluate);
    if (snapshot) {
      const pairing = pairGeminiPromptAndAssistant(snapshot.entries, authority);
      if (pairing.status === "paired") return { text: pairing.response.text.trim() };
      if (pairing.status === "prompt-mismatch") {
        throw new BrowserAutomationError(
          "Recovered Gemini turn does not match the committed prompt epoch.",
          { stage: "prompt-epoch", code: "committed-prompt-identity-mismatch" },
        );
      }
      if (pairing.status === "unsupported") {
        switch (pairing.issue) {
          case "user-identity-ambiguous":
            throw new BrowserAutomationError(
              "Gemini rendered the committed provider user identity more than once during reattach.",
              {
                stage: "prompt-epoch",
                code: "committed-prompt-identity-mismatch",
                reattachable: false,
              },
            );
          case "multiple-responses":
            throw new BrowserAutomationError(
              "Gemini exposes multiple completed responses for the committed prompt epoch.",
              {
                stage: "gemini-response-capture",
                code: "gemini-response-ownership-ambiguous",
                reattachable: false,
              },
            );
          case "response-identity-unavailable":
            throw new BrowserAutomationError(
              "Gemini completed response lacks a stable provider message identifier during reattach.",
              {
                stage: "gemini-response-capture",
                code: "gemini-response-ownership-unavailable",
                reattachable: false,
              },
            );
          case "response-identity-ambiguous":
            throw new BrowserAutomationError(
              "Gemini completed response identity is not unique in the current conversation DOM during reattach.",
              {
                stage: "gemini-response-capture",
                code: "gemini-response-ownership-ambiguous",
                reattachable: false,
              },
            );
          case "user-identity-unavailable":
            throw new BrowserAutomationError(
              "Committed Gemini prompt lacks an immutable provider user identity for exact reattach.",
              {
                stage: "prompt-epoch",
                code: "gemini-reattach-authority-unavailable",
                reattachable: false,
              },
            );
        }
      }
    }
    await ctx.delay(1_000);
  }
  throw new Error("Timed out waiting for the committed Gemini response during reattach.");
}
