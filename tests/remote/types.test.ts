import { describe, expect, it } from "vitest";
import {
  REMOTE_IDENTIFIER_PATTERN,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  RemoteBrowserAutomationErrorSchema,
  RemoteBrowserRunConfigSchema,
  RemoteRunOptionsSchema,
  RemoteRunPayloadSchema,
  RemoteRunTransactionPayloadSchema,
  RemoteSettlementAuthoritySchema,
  RemoteTransactionSettlementResponseSchema,
  RemoteTransactionRetryResponseSchema,
  isTrustedChatGptUrl,
} from "../../src/remote/types.js";
import {
  RemoteLegacyBrowserRunConfigSchema,
  RemoteLegacyRunPayloadSchema,
} from "../../src/remote/legacyProtocol.js";

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
        settlementAuthority: { mode: "finalize", outcome: "bound", state: "pending" },
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
        settlementAuthority: { mode: "finalize", outcome: "completed", state: "finalized" },
        finalization: {
          status: "completed",
          runtime: { promptEpoch, cleanup: { status: "completed" } },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects settlement authorities whose mode, outcome, and state contradict", () => {
    expect(
      RemoteSettlementAuthoritySchema.safeParse({
        mode: "finalize",
        outcome: "bound",
        state: "pending",
      }).success,
    ).toBe(true);
    expect(
      RemoteSettlementAuthoritySchema.safeParse({
        mode: "abort",
        outcome: "completed",
        state: "aborted",
      }).success,
    ).toBe(true);
    expect(
      RemoteSettlementAuthoritySchema.safeParse({
        mode: "finalize",
        outcome: "completed",
        state: "aborted",
      }).success,
    ).toBe(false);
    expect(
      RemoteSettlementAuthoritySchema.safeParse({
        mode: "abort",
        outcome: "bound",
        state: "finalized",
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
        message: "abort-bound disconnect",
        recoverableDisconnect: true,
        recoveryToken: transactionToken,
        settlementMode: "abort",
        runtime: { promptEpoch, cleanup: { status: "pending" } },
      }).success,
    ).toBe(true);
    expect(
      RemoteBrowserAutomationErrorSchema.safeParse({
        name: "BrowserAutomationError",
        category: "browser-automation",
        message: "invalid bound disconnect",
        recoverableDisconnect: true,
        recoveryToken: transactionToken,
        settlementMode: "resume",
        runtime: { promptEpoch, cleanup: { status: "pending" } },
      }).success,
    ).toBe(false);
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

  it("correlates token-bound terminal retry outcomes with completed settlement state", () => {
    expect(
      RemoteTransactionRetryResponseSchema.safeParse({
        status: "terminal",
        transactionToken,
        outcome: {
          state: "finalized",
          finalization: {
            status: "completed",
            runtime: { promptEpoch, cleanup: { status: "completed" } },
          },
        },
      }).success,
    ).toBe(true);
    expect(
      RemoteTransactionRetryResponseSchema.safeParse({
        status: "terminal",
        transactionToken,
        outcome: {
          state: "finalized",
          finalization: {
            status: "pending",
            runtime: { promptEpoch, cleanup: { status: "pending" } },
            error: "still closing",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      RemoteTransactionRetryResponseSchema.safeParse({
        status: "terminal",
        outcome: {
          state: "failed",
          error: {
            name: "BrowserAutomationError",
            category: "browser-automation",
            message: "failed",
            recoverableDisconnect: false,
          },
        },
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

  it("shares trusted URL and identifier policies with the legacy protocol", () => {
    for (const [value, accepted] of [
      ["https://chatgpt.com/", true],
      ["https://chat.openai.com/c/example", true],
      ["http://chatgpt.com/", false],
      ["https://chatgpt.com.evil.invalid/", false],
      ["https://user@chatgpt.com/", false],
    ] as const) {
      expect(isTrustedChatGptUrl(value)).toBe(accepted);
      expect(RemoteBrowserRunConfigSchema.safeParse({ chatgptUrl: value }).success).toBe(accepted);
      expect(RemoteLegacyBrowserRunConfigSchema.safeParse({ chatgptUrl: value }).success).toBe(
        accepted,
      );
    }

    for (const [value, accepted] of [
      ["session-1", true],
      ["a".repeat(256), true],
      ["a".repeat(257), false],
      ["-session", false],
      ["session/id", false],
    ] as const) {
      expect(REMOTE_IDENTIFIER_PATTERN.test(value)).toBe(accepted);
      expect(RemoteRunOptionsSchema.safeParse({ sessionId: value }).success).toBe(accepted);
      expect(
        RemoteLegacyRunPayloadSchema.safeParse({
          prompt: "hello",
          attachments: [],
          browserConfig: {},
          options: { sessionId: value },
        }).success,
      ).toBe(accepted);
    }
  });
});
