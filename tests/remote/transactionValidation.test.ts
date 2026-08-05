import { describe, expect, test } from "vitest";
import {
  applyRemoteTransactionTransition,
  createRemoteTransactionRecord,
} from "../../src/remote/transactionReducer.js";
import type {
  DurableRemoteArtifactRegistration,
  RemoteTransactionRecord,
  RemoteTransactionReducerContext,
} from "../../src/remote/transactionModel.js";
import {
  remoteTransactionSettlementPhase,
  validateRemoteStagedCapture,
  validateRemoteTerminalAudit,
  validateRemoteTransactionRecord,
} from "../../src/remote/transactionValidation.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";

const transactionToken = "a".repeat(64);
const now = Date.parse("2026-01-01T00:00:00.000Z");
const context: RemoteTransactionReducerContext = {
  controllerGeneration: "controller-generation-1",
  leaseDurationMs: 60_000,
  now: () => now,
  nowIso: () => new Date(now).toISOString(),
};
const promptEpoch = {
  status: "committed" as const,
  epochId: "epoch-1",
  promptSha256: "b".repeat(64),
  baselineTurns: 1,
  followUpOrdinal: 0,
  remainingFollowUps: 0,
  verifiedUserTurnIndex: 1,
  verifiedUserTurnId: "user-turn-1",
  verifiedUserMessageId: "user-message-1",
  conversationId: "conversation-1",
};
const runtime = {
  chromeTargetId: "target-1",
  conversationId: promptEpoch.conversationId,
  promptEpoch,
  recoveryCleanupResources: [
    {
      chromeTargetId: "target-1",
      conversationId: promptEpoch.conversationId,
      promptEpoch,
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "temporary" as const,
        keepBrowser: false,
        closeOwnedTargetOnComplete: true,
      },
    },
  ],
};
const result = {
  answerText: "captured",
  answerMarkdown: "captured",
  tookMs: 1,
  answerTokens: 1,
  answerChars: 8,
};

function initialRecord(): RemoteTransactionRecord {
  return createRemoteTransactionRecord(
    {
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      transactionToken,
      runId: "run-1",
      createdAt: new Date(now).toISOString(),
      requestIdentity: {
        acceptedPromptSha256: [promptEpoch.promptSha256],
        followUpOrdinal: 0,
        remainingFollowUps: 0,
      },
      browserConfig: { chatgptUrl: "https://chatgpt.com/" },
    },
    context,
  );
}

function artifact(): DurableRemoteArtifactRegistration {
  return {
    transactionToken,
    canonicalPath: "/private/server/result.bin",
    fileIdentity: {
      device: "1",
      inode: "2",
      birthtimeNs: "3",
      ctimeNs: "4",
    },
    descriptor: {
      artifactId: "artifact-1",
      runId: "run-1",
      kind: "file",
      filename: "result.bin",
      mimeType: "application/octet-stream",
      byteSize: 7,
      sha256: "c".repeat(64),
      sourceUrlKind: "browser-download",
      transferStatus: "ready",
      required: true,
    },
  };
}

function restarted(record: RemoteTransactionRecord): RemoteTransactionRecord {
  return JSON.parse(JSON.stringify(record)) as RemoteTransactionRecord;
}

describe("remote transaction model validation", () => {
  test("uses the canonical staged and artifact validators before persistence and after restart", () => {
    const initial = initialRecord();
    const staged = applyRemoteTransactionTransition(
      initial,
      {
        type: "stage-capture",
        runId: "run-1",
        result,
        runtime,
        artifacts: [artifact()],
      },
      context,
    ).record;

    expect(initial).not.toHaveProperty("stagedCapture");
    expect(() => validateRemoteStagedCapture(staged)).not.toThrow();
    expect(() =>
      validateRemoteTransactionRecord(restarted(staged), {
        expectedTransactionToken: transactionToken,
        maximumLeaseDurationMs: context.leaseDurationMs,
      }),
    ).not.toThrow();

    const invalidArtifact = artifact();
    invalidArtifact.deliveryReceipt = {
      receiptId: "receipt-1",
      deliveredAt: new Date(now).toISOString(),
      byteSize: 8,
      sha256: invalidArtifact.descriptor.sha256,
    };
    let liveError: unknown;
    try {
      applyRemoteTransactionTransition(
        initial,
        {
          type: "stage-capture",
          runId: "run-1",
          result,
          runtime,
          artifacts: [invalidArtifact],
        },
        context,
      );
    } catch (error) {
      liveError = error;
    }

    const invalidRestart = restarted(staged);
    invalidRestart.stagedCapture!.artifacts![0]!.deliveryReceipt = invalidArtifact.deliveryReceipt;
    let restartError: unknown;
    try {
      validateRemoteTransactionRecord(invalidRestart, {
        expectedTransactionToken: transactionToken,
        maximumLeaseDurationMs: context.leaseDurationMs,
      });
    } catch (error) {
      restartError = error;
    }

    expect(liveError).toMatchObject({ code: "artifact_delivery_receipt_invalid" });
    expect(restartError).toMatchObject({ code: "artifact_delivery_receipt_invalid" });
  });

  test("keeps bind, execution, conflict, and terminal authority deterministic across restart", () => {
    const published = applyRemoteTransactionTransition(
      initialRecord(),
      {
        type: "publish-capture",
        runId: "run-1",
        result,
        runtime,
        artifacts: [],
      },
      context,
    ).record;
    expect(remoteTransactionSettlementPhase(published)).toBe("unbound");
    const bound = applyRemoteTransactionTransition(
      published,
      { type: "bind-settlement", mode: "finalize", durablePublication: false },
      context,
    ).record;

    expect(remoteTransactionSettlementPhase(bound)).toBe("mode-bound");
    expect(remoteTransactionSettlementPhase(restarted(bound))).toBe("mode-bound");
    expect(bound.runtime).toEqual(runtime);
    expect(() =>
      applyRemoteTransactionTransition(
        bound,
        { type: "begin-settlement-execution", mode: "finalize" },
        context,
      ),
    ).toThrow("Durable answer publication acknowledgement is required");

    const acknowledged = applyRemoteTransactionTransition(
      bound,
      { type: "bind-settlement", mode: "finalize", durablePublication: true },
      context,
    ).record;
    const expiredContext: RemoteTransactionReducerContext = {
      ...context,
      now: () => now + context.leaseDurationMs + 1,
      nowIso: () => new Date(now + context.leaseDurationMs + 1).toISOString(),
    };
    const unpublishedExpiry = applyRemoteTransactionTransition(
      bound,
      {
        type: "expire",
        expectedLeaseExpiresAt: bound.leaseExpiresAt,
        buildError: (_record, hadRuntimeAuthority) => ({
          name: "BrowserAutomationError",
          category: "browser-automation",
          message: "expired",
          recoverableDisconnect: hadRuntimeAuthority,
        }),
      },
      expiredContext,
    );
    expect(unpublishedExpiry.outcome).toBeNull();
    expect(remoteTransactionSettlementPhase(unpublishedExpiry.record)).toBe("mode-bound");
    expect(unpublishedExpiry.record.settlementMode).toBe("finalize");

    const acknowledgedExpiry = applyRemoteTransactionTransition(
      acknowledged,
      {
        type: "expire",
        expectedLeaseExpiresAt: acknowledged.leaseExpiresAt,
        buildError: (_record, hadRuntimeAuthority) => ({
          name: "BrowserAutomationError",
          category: "browser-automation",
          message: "expired",
          recoverableDisconnect: hadRuntimeAuthority,
        }),
      },
      expiredContext,
    );
    expect(acknowledgedExpiry.outcome).toEqual({ mode: "finalize", durablePublication: true });
    expect(remoteTransactionSettlementPhase(acknowledgedExpiry.record)).toBe("mode-bound");
    const executing = applyRemoteTransactionTransition(
      acknowledged,
      { type: "begin-settlement-execution", mode: "finalize" },
      context,
    ).record;
    expect(remoteTransactionSettlementPhase(executing)).toBe("executing-or-pending");
    expect(remoteTransactionSettlementPhase(restarted(executing))).toBe("executing-or-pending");
    expect(executing.settlementExecutionStartedAt).toBe(context.nowIso());
    expect(executing.runtime?.recoveryCleanupResult).toMatchObject({
      status: "pending",
      settlementMode: "finalize",
    });

    let boundConflict: unknown;
    try {
      applyRemoteTransactionTransition(
        executing,
        { type: "bind-settlement", mode: "abort", durablePublication: false },
        context,
      );
    } catch (error) {
      boundConflict = error;
    }
    expect(boundConflict).toMatchObject({
      code: "transaction_settlement_conflict",
      settlementAuthority: { mode: "finalize", outcome: "bound", state: "pending" },
    });

    for (const transition of [
      { type: "begin-settlement-execution", mode: "abort" } as const,
      {
        type: "complete-settlement",
        mode: "abort",
        finalization: { status: "completed", runtime },
      } as const,
    ]) {
      let conflict: unknown;
      try {
        applyRemoteTransactionTransition(executing, transition, context);
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toMatchObject({
        code: "transaction_settlement_conflict",
        settlementAuthority: { mode: "finalize", outcome: "bound", state: "pending" },
      });
    }

    const terminal = applyRemoteTransactionTransition(
      executing,
      {
        type: "complete-settlement",
        mode: "finalize",
        finalization: { status: "completed", runtime },
      },
      context,
    ).record;
    expect(remoteTransactionSettlementPhase(terminal)).toBe("terminal");
    expect(remoteTransactionSettlementPhase(restarted(terminal))).toBe("terminal");
    expect(() => validateRemoteTerminalAudit(terminal)).not.toThrow();
    expect(() =>
      validateRemoteTransactionRecord(restarted(terminal), {
        expectedTransactionToken: transactionToken,
        maximumLeaseDurationMs: context.leaseDurationMs,
      }),
    ).not.toThrow();

    let terminalConflict: unknown;
    try {
      applyRemoteTransactionTransition(
        terminal,
        { type: "bind-settlement", mode: "abort", durablePublication: false },
        context,
      );
    } catch (error) {
      terminalConflict = error;
    }
    expect(terminalConflict).toMatchObject({
      code: "transaction_already_settled",
      settlementAuthority: { mode: "finalize", outcome: "completed", state: "finalized" },
    });

    let terminalCompletionConflict: unknown;
    try {
      applyRemoteTransactionTransition(
        terminal,
        {
          type: "complete-settlement",
          mode: "abort",
          finalization: { status: "completed", runtime },
        },
        context,
      );
    } catch (error) {
      terminalCompletionConflict = error;
    }
    expect(terminalCompletionConflict).toMatchObject({
      code: "transaction_already_settled",
      settlementAuthority: { mode: "finalize", outcome: "completed", state: "finalized" },
    });
  });

  test("durably starts settlement before authority-free cleanup completes", () => {
    const authorityFreeRuntime = {
      conversationId: promptEpoch.conversationId,
      promptEpoch,
    };
    const published = applyRemoteTransactionTransition(
      initialRecord(),
      {
        type: "publish-capture",
        runId: "run-1",
        result,
        runtime: authorityFreeRuntime,
        artifacts: [],
      },
      context,
    ).record;
    const bound = applyRemoteTransactionTransition(
      published,
      { type: "bind-settlement", mode: "finalize", durablePublication: true },
      context,
    ).record;
    expect(() =>
      applyRemoteTransactionTransition(
        bound,
        {
          type: "complete-settlement",
          mode: "finalize",
          finalization: { status: "completed", runtime: authorityFreeRuntime },
        },
        context,
      ),
    ).toThrow("before durable settlement execution begins");
    const executing = applyRemoteTransactionTransition(
      bound,
      { type: "begin-settlement-execution", mode: "finalize" },
      context,
    ).record;

    expect(executing.runtime).toEqual(authorityFreeRuntime);
    expect(executing.settlementExecutionStartedAt).toBe(context.nowIso());
    expect(remoteTransactionSettlementPhase(restarted(executing))).toBe("executing-or-pending");

    const terminal = applyRemoteTransactionTransition(
      executing,
      {
        type: "complete-settlement",
        mode: "finalize",
        finalization: { status: "completed", runtime: authorityFreeRuntime },
      },
      context,
    ).record;
    expect(remoteTransactionSettlementPhase(terminal)).toBe("terminal");
    expect(terminal).not.toHaveProperty("settlementExecutionStartedAt");
  });
});
