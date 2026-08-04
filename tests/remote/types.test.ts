import { describe, expect, it } from "vitest";
import {
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  RemoteBrowserAutomationErrorSchema,
  RemoteRunPayloadSchema,
  RemoteRunTransactionPayloadSchema,
  RemoteTransactionSettlementResponseSchema,
} from "../../src/remote/types.js";

const transactionToken = "a".repeat(64);
const promptEpoch = {
  status: "committed" as const,
  epochId: "epoch-1",
  promptSha256: "b".repeat(64),
  baselineTurns: 0,
  followUpOrdinal: 0,
  remainingFollowUps: 0,
  verifiedUserTurnIndex: 0,
  verifiedUserTurnId: "turn-1",
  verifiedUserMessageId: "message-1",
  conversationId: "conversation-1",
};
const result = {
  answerText: "answer",
  answerMarkdown: "answer",
  tookMs: 1,
  answerTokens: 1,
  answerChars: 6,
};

function pendingTransaction() {
  return {
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    transactionToken,
    runId: "run-1",
    result,
    runtime: { promptEpoch, cleanup: { status: "pending" as const } },
    artifacts: [],
    state: "pending" as const,
  };
}

describe("remote public protocol schemas", () => {
  it("rejects host runtime authority and unknown result fields", () => {
    expect(
      RemoteRunTransactionPayloadSchema.safeParse({
        ...pendingTransaction(),
        runtime: {
          ...pendingTransaction().runtime,
          chromePid: 1234,
          userDataDir: "/private/host/profile",
          chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/private",
        },
      }).success,
    ).toBe(false);
    expect(
      RemoteRunTransactionPayloadSchema.safeParse({
        ...pendingTransaction(),
        result: { ...result, chromeTargetId: "host-target", controllerPid: 42 },
      }).success,
    ).toBe(false);
  });

  it("rejects invalid transaction and settlement state cross-products", () => {
    expect(
      RemoteRunTransactionPayloadSchema.safeParse({
        ...pendingTransaction(),
        state: "finalized",
      }).success,
    ).toBe(false);
    expect(
      RemoteTransactionSettlementResponseSchema.safeParse({
        transactionToken,
        state: "finalized",
        finalization: {
          status: "pending",
          runtime: { promptEpoch, cleanup: { status: "pending" } },
          error: "still open",
        },
      }).success,
    ).toBe(false);
    expect(
      RemoteTransactionSettlementResponseSchema.safeParse({
        transactionToken,
        state: "pending",
        finalization: {
          status: "completed",
          runtime: { promptEpoch, cleanup: { status: "completed" } },
        },
      }).success,
    ).toBe(false);
  });

  it("requires recoverable errors to carry one opaque capability and public runtime only", () => {
    expect(
      RemoteBrowserAutomationErrorSchema.safeParse({
        name: "BrowserAutomationError",
        category: "browser-automation",
        message: "disconnected",
        recoverableDisconnect: true,
        recoveryToken: transactionToken,
        runtime: { promptEpoch, cleanup: { status: "pending" } },
      }).success,
    ).toBe(true);
    expect(
      RemoteBrowserAutomationErrorSchema.safeParse({
        name: "BrowserAutomationError",
        category: "browser-automation",
        message: "disconnected",
        recoverableDisconnect: true,
        recoveryToken: transactionToken,
        runtime: { promptEpoch, cleanup: { status: "pending" }, chromePort: 9222 },
      }).success,
    ).toBe(false);
    expect(
      RemoteBrowserAutomationErrorSchema.safeParse({
        name: "BrowserAutomationError",
        category: "browser-automation",
        message: "failed",
        recoverableDisconnect: false,
        recoveryToken: transactionToken,
      }).success,
    ).toBe(false);
  });

  it("rejects request-side host authority rather than stripping it", () => {
    expect(
      RemoteRunPayloadSchema.safeParse({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        prompt: "hello",
        attachments: [],
        browserConfig: { remoteChrome: { host: "attacker.invalid", port: 9222 } },
        options: {},
      }).success,
    ).toBe(false);
    expect(
      RemoteRunPayloadSchema.safeParse({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        transactionToken,
        prompt: "hello",
        attachments: [],
        browserConfig: {},
        options: {},
      }).success,
    ).toBe(false);
  });
});
