import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { resolveCommittedPromptEpochLocator } from "../../src/browser/reattachability.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const browserSmokePath = path.join(root, "scripts", "browser-smoke.sh");
const disconnectProofPath = path.join(root, "scripts", "oracle-e2e-cdp-disconnect-proof.mjs");

const committedRuntime = {
  chromePort: 9222,
  conversationId: "smoke-conversation",
  promptEpoch: {
    status: "committed" as const,
    epochId: "smoke-epoch",
    promptSha256: "a".repeat(64),
    baselineTurns: 0,
    followUpOrdinal: 0,
    remainingFollowUps: 0,
    verifiedUserTurnIndex: 0,
    verifiedUserTurnId: "turn-smoke",
    verifiedUserMessageId: "message-smoke",
    conversationId: "smoke-conversation",
  },
};

describe("browser smoke prompt commitment readiness", () => {
  test("gates both controller-loss proofs on committed prompt-epoch authority", async () => {
    const [browserSmoke, disconnectProof] = await Promise.all([
      readFile(browserSmokePath, "utf8"),
      readFile(disconnectProofPath, "utf8"),
    ]);

    for (const source of [browserSmoke, disconnectProof]) {
      expect(source).not.toMatch(/prompt[S]ubmitted/);
      expect(source).toContain("resolveCommittedPromptEpochLocator");
    }
    expect(resolveCommittedPromptEpochLocator(committedRuntime)).not.toBeNull();
    expect(resolveCommittedPromptEpochLocator({ chromePort: 9222 })).toBeNull();
  });
});
