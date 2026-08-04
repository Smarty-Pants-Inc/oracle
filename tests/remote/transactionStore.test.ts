import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";
import {
  RemoteTransactionCapacityError,
  RemoteTransactionStore,
} from "../../src/remote/transactionStore.js";

const committedPromptEpoch = {
  status: "committed" as const,
  epochId: "epoch-1",
  promptSha256: "a".repeat(64),
  baselineTurns: 1,
  followUpOrdinal: 0,
  remainingFollowUps: 0,
  verifiedUserTurnIndex: 1,
  verifiedUserTurnId: "user-turn-1",
  verifiedUserMessageId: "user-message-1",
  conversationId: "conversation-1",
};

function restartError(hadRuntimeAuthority: boolean) {
  return {
    name: "BrowserAutomationError" as const,
    category: "browser-automation" as const,
    message: hadRuntimeAuthority
      ? "The prior remote controller stopped after browser authority was journaled."
      : "The prior remote controller stopped before browser authority was acquired.",
    stage: "remote-controller-restart",
    recoverableDisconnect: hadRuntimeAuthority,
  };
}

describe("RemoteTransactionStore", () => {
  test("reconciles stale running generations without losing journaled prompt and cleanup authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-transaction-store-"));
    const transactionToken = "a".repeat(64);
    const createdAt = new Date().toISOString();
    try {
      const firstController = await RemoteTransactionStore.open({
        directory: root,
        controllerGeneration: "controller-generation-1",
      });
      await firstController.create({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        transactionToken,
        runId: "run-1",
        createdAt,
        updatedAt: createdAt,
        state: "running",
      });
      await firstController.journalRuntime(transactionToken, {
        chromeTargetId: "target-1",
        conversationId: committedPromptEpoch.conversationId,
        promptEpoch: committedPromptEpoch,
        recoveryCleanupResources: [
          {
            chromeTargetId: "target-1",
            conversationId: committedPromptEpoch.conversationId,
            promptEpoch: committedPromptEpoch,
            recoveryCleanup: {
              transport: "local",
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
            },
          },
        ],
      });

      const restartedController = await RemoteTransactionStore.open({
        directory: root,
        controllerGeneration: "controller-generation-2",
      });
      await expect(
        restartedController.reconcileStaleRunningRecords({
          buildError: (_record, hadRuntimeAuthority) => restartError(hadRuntimeAuthority),
        }),
      ).resolves.toEqual([
        {
          transactionToken,
          previousControllerGeneration: "controller-generation-1",
          state: "recoverable-error",
          hadRuntimeAuthority: true,
        },
      ]);

      await expect(restartedController.read(transactionToken)).resolves.toMatchObject({
        controllerGeneration: "controller-generation-2",
        state: "recoverable-error",
        runtime: {
          chromeTargetId: "target-1",
          conversationId: "conversation-1",
          promptEpoch: committedPromptEpoch,
          recoveryCleanupResources: [{ recoveryCleanup: { ownsTarget: true } }],
        },
        runtimeJournaledAt: expect.any(String),
        restartRecovery: {
          previousControllerGeneration: "controller-generation-1",
          reason: "controller-generation-changed",
          reconciledAt: expect.any(String),
        },
        error: {
          stage: "remote-controller-restart",
          recoverableDisconnect: true,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails a stale pre-authority run instead of inventing cleanup authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-pre-authority-"));
    const transactionToken = "b".repeat(64);
    const createdAt = new Date().toISOString();
    try {
      const firstController = await RemoteTransactionStore.open({
        directory: root,
        controllerGeneration: "controller-generation-1",
      });
      await firstController.create({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        transactionToken,
        runId: "run-2",
        createdAt,
        updatedAt: createdAt,
        state: "running",
      });

      const restartedController = await RemoteTransactionStore.open({
        directory: root,
        controllerGeneration: "controller-generation-2",
      });
      await restartedController.reconcileStaleRunningRecords({
        buildError: (_record, hadRuntimeAuthority) => restartError(hadRuntimeAuthority),
      });

      const failedRecord = await restartedController.read(transactionToken);
      expect(failedRecord).toMatchObject({
        state: "failed",
        controllerGeneration: "controller-generation-2",
        terminalAudit: { errorStage: "remote-controller-restart" },
      });
      expect(failedRecord).not.toHaveProperty("result");
      expect(failedRecord).not.toHaveProperty("artifacts");
      expect(failedRecord).not.toHaveProperty("settlementMode");
      expect(failedRecord).not.toHaveProperty("publicationAcknowledgedAt");
      expect(failedRecord).not.toHaveProperty("runtime");
      expect(failedRecord).not.toHaveProperty("error");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects new transactions before side effects when record capacity is exhausted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-record-capacity-"));
    const createdAt = new Date().toISOString();
    try {
      const store = await RemoteTransactionStore.open({
        directory: root,
        maximumRecords: 1,
      });
      await store.create({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        transactionToken: "c".repeat(64),
        runId: "run-capacity-1",
        createdAt,
        updatedAt: createdAt,
        state: "running",
      });
      await expect(
        store.create({
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          transactionToken: "d".repeat(64),
          runId: "run-capacity-2",
          createdAt,
          updatedAt: createdAt,
          state: "running",
        }),
      ).rejects.toMatchObject({
        name: "RemoteTransactionCapacityError",
        code: "remote_transaction_capacity_exhausted",
      });
      await expect(store.list()).resolves.toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a transaction whose durable record exceeds the byte quota", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-byte-capacity-"));
    const createdAt = new Date().toISOString();
    try {
      const store = await RemoteTransactionStore.open({ directory: root, maximumBytes: 64 });
      await expect(
        store.create({
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          transactionToken: "e".repeat(64),
          runId: "run-byte-capacity",
          createdAt,
          updatedAt: createdAt,
          state: "running",
        }),
      ).rejects.toBeInstanceOf(RemoteTransactionCapacityError);
      await expect(store.list()).resolves.toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("redacts terminal answers, runtime paths, and artifact paths while retaining receipt audit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-terminal-redaction-"));
    const transactionToken = "f".repeat(64);
    const createdAt = new Date().toISOString();
    try {
      const store = await RemoteTransactionStore.open({ directory: root });
      await store.create({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        transactionToken,
        runId: "run-redaction",
        createdAt,
        updatedAt: createdAt,
        state: "pending",
        result: {
          answerText: "sensitive answer",
          answerMarkdown: "sensitive answer",
          tookMs: 1,
          answerTokens: 2,
          answerChars: 16,
        },
        runtime: {
          userDataDir: "/private/server/profile",
          chromeTargetId: "secret-target",
          conversationId: committedPromptEpoch.conversationId,
          promptEpoch: committedPromptEpoch,
        },
        artifacts: [
          {
            descriptor: {
              artifactId: "artifact-1",
              runId: "run-redaction",
              kind: "file",
              filename: "result.bin",
              byteSize: 7,
              sha256: "b".repeat(64),
              sourceUrlKind: "browser-download",
              transferStatus: "ready",
              required: true,
            },
            transactionToken,
            canonicalPath: "/private/server/result.bin",
            fileIdentity: {
              device: "1",
              inode: "2",
              birthtimeNs: "3",
              ctimeNs: "4",
            },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            deliveryReceipt: {
              receiptId: "receipt-1",
              deliveredAt: createdAt,
              byteSize: 7,
              sha256: "b".repeat(64),
            },
          },
        ],
      });
      await store.update(transactionToken, (record) => {
        record.state = "aborted";
        record.settlementMode = "abort";
        record.finalization = { status: "completed", runtime: record.runtime ?? {} };
      });

      const terminalRecord = await store.read(transactionToken);
      expect(terminalRecord).toMatchObject({
        state: "aborted",
        finalization: {
          status: "completed",
          runtime: { promptEpoch: committedPromptEpoch },
        },
        terminalAudit: {
          settlementMode: "abort",
          artifacts: [
            {
              artifactId: "artifact-1",
              required: true,
              deliveryReceipt: { receiptId: "receipt-1" },
            },
          ],
        },
      });
      expect(terminalRecord).not.toHaveProperty("result");
      expect(terminalRecord).not.toHaveProperty("runtime");
      expect(terminalRecord).not.toHaveProperty("artifacts");
      expect(terminalRecord).not.toHaveProperty("settlementMode");
      expect(terminalRecord).not.toHaveProperty("publicationAcknowledgedAt");
      const raw = await readFile(store.recordPath(transactionToken), "utf8");
      expect(raw).not.toContain("sensitive answer");
      expect(raw).not.toContain("/private/server");
      expect(raw).not.toContain("secret-target");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("prunes terminal records after the configured recovery retention window", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-terminal-retention-"));
    const transactionToken = "1".repeat(64);
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const createdAt = new Date(now).toISOString();
    try {
      const first = await RemoteTransactionStore.open({
        directory: root,
        terminalRetentionMs: 1_000,
        now: () => now,
      });
      await first.create({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        transactionToken,
        runId: "run-retention",
        createdAt,
        updatedAt: createdAt,
        state: "running",
      });
      await first.update(transactionToken, (record) => {
        record.state = "failed";
        record.error = restartError(false);
      });
      now += 1_001;
      const reopened = await RemoteTransactionStore.open({
        directory: root,
        terminalRetentionMs: 1_000,
        now: () => now,
      });
      await expect(reopened.read(transactionToken)).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
