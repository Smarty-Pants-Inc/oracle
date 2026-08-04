import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import {
  REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
} from "../../src/remote/types.js";
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

const nonterminalAuthority = {
  requestIdentity: {
    acceptedPromptSha256: ["9".repeat(64)],
    followUpOrdinal: 0,
    remainingFollowUps: 0 as const,
  },
  browserConfig: { chatgptUrl: "https://chatgpt.com/" },
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
        ...nonterminalAuthority,
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
              closeOwnedTargetOnComplete: true,
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
        ...nonterminalAuthority,
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

  test("counts captured pending transactions against the bounded record limit", async () => {
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
        state: "pending",
        ...nonterminalAuthority,
      });
      await expect(
        store.create({
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          transactionToken: "d".repeat(64),
          runId: "run-capacity-2",
          createdAt,
          updatedAt: createdAt,
          state: "pending",
          ...nonterminalAuthority,
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
          ...nonterminalAuthority,
        }),
      ).rejects.toBeInstanceOf(RemoteTransactionCapacityError);
      await expect(store.list()).resolves.toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("never exposes a partial create record or overwrites an existing token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-atomic-create-"));
    const interruptedToken = "0".repeat(64);
    const duplicateToken = "f".repeat(64);
    const createdAt = new Date().toISOString();
    const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    const link = vi.fn(actualFs.link);
    link.mockRejectedValueOnce(
      Object.assign(new Error("publication interrupted"), { code: "EINTR" }),
    );
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actualFs, link }));
    // Static imports cannot rebind the built-in ESM export; reload this test-isolated module.
    const { RemoteTransactionStore: IsolatedRemoteTransactionStore } =
      await import("../../src/remote/transactionStore.js");
    try {
      const store = await IsolatedRemoteTransactionStore.open({ directory: root });
      await expect(
        store.create({
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          transactionToken: interruptedToken,
          runId: "interrupted-create",
          createdAt,
          updatedAt: createdAt,
          state: "pending",
          ...nonterminalAuthority,
        }),
      ).rejects.toMatchObject({ code: "EINTR" });
      await expect(fs.access(store.recordPath(interruptedToken))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readdir(root)).toEqual([]);

      await store.create({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        transactionToken: duplicateToken,
        runId: "original-create",
        createdAt,
        updatedAt: createdAt,
        state: "pending",
        ...nonterminalAuthority,
      });
      const original = await readFile(store.recordPath(duplicateToken), "utf8");
      await expect(
        store.create({
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          transactionToken: duplicateToken,
          runId: "replacement-attempt",
          createdAt,
          updatedAt: createdAt,
          state: "pending",
          ...nonterminalAuthority,
        }),
      ).rejects.toMatchObject({ code: "EEXIST" });
      await expect(readFile(store.recordPath(duplicateToken), "utf8")).resolves.toBe(original);
      expect(await fs.readdir(root)).toEqual([`${duplicateToken}.json`]);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("charges sixteen abandoned captured records by actual bytes instead of running reservation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-captured-capacity-"));
    const createdAt = new Date().toISOString();
    try {
      const store = await RemoteTransactionStore.open({ directory: root });
      for (let index = 0; index < 16; index += 1) {
        await store.create({
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          transactionToken: index.toString(16).padStart(64, "0"),
          runId: `captured-${index}`,
          createdAt,
          updatedAt: createdAt,
          state: "pending",
          ...nonterminalAuthority,
          result: {
            answerText: "captured",
            answerMarkdown: "captured",
            tookMs: 1,
            answerTokens: 1,
            answerChars: 8,
          },
        });
      }

      const runningToken = "f".repeat(64);
      await expect(
        store.create({
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          transactionToken: runningToken,
          runId: "running-after-captures",
          createdAt,
          updatedAt: createdAt,
          state: "running",
          ...nonterminalAuthority,
        }),
      ).resolves.toBeUndefined();

      const records = await store.list();
      expect(records).toHaveLength(17);
      expect(records.filter((record) => record.state === "pending")).toHaveLength(16);
      expect(records.find((record) => record.transactionToken === runningToken)).toMatchObject({
        capacityReservationBytes: REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES,
      });
      expect(records.find((record) => record.state === "pending")).not.toHaveProperty(
        "capacityReservationBytes",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("renews leases only on explicit persistence and lists expired records deterministically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-lease-"));
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const createdAt = new Date(now).toISOString();
    const passiveToken = "1".repeat(64);
    const secondExpiredToken = "4".repeat(64);
    const renewedToken = "2".repeat(64);
    const persistedToken = "3".repeat(64);
    try {
      const store = await RemoteTransactionStore.open({
        directory: root,
        leaseDurationMs: 1_000,
        now: () => now,
      });
      for (const [transactionToken, runId] of [
        [secondExpiredToken, "expired-second"],
        [passiveToken, "expired-first"],
        [renewedToken, "renewed"],
        [persistedToken, "persisted"],
      ] as const) {
        await store.create({
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          transactionToken,
          runId,
          createdAt,
          updatedAt: createdAt,
          state: "pending",
          ...nonterminalAuthority,
        });
      }
      const runningToken = "5".repeat(64);
      await store.create({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        transactionToken: runningToken,
        runId: "runtime-journal",
        createdAt,
        updatedAt: createdAt,
        state: "running",
        ...nonterminalAuthority,
      });
      const initialRuntimeLease = (await store.read(runningToken))?.leaseExpiresAt;
      const initialPassiveLease = (await store.read(passiveToken))?.leaseExpiresAt;

      now += 500;
      await store.read(passiveToken);
      const renewed = await store.renewLease(renewedToken);
      await store.update(persistedToken, () => undefined);
      const journaled = await store.journalRuntime(runningToken, {
        chromeTargetId: "runtime-target",
      });
      expect(Date.parse(renewed.leaseExpiresAt ?? "")).toBe(now + 1_000);
      expect(journaled.leaseExpiresAt).not.toBe(initialRuntimeLease);

      now += 501;
      await expect(store.listExpiredNonterminalRecords()).resolves.toEqual([
        expect.objectContaining({ transactionToken: passiveToken }),
        expect.objectContaining({ transactionToken: secondExpiredToken }),
      ]);
      expect((await store.read(passiveToken))?.leaseExpiresAt).toBe(initialPassiveLease);
      await expect(store.renewLease(passiveToken)).rejects.toThrow(
        "Cannot renew an expired remote transaction lease",
      );
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
        ...nonterminalAuthority,
        browserConfig: {
          ...nonterminalAuthority.browserConfig,
          manualLoginProfileDir: "/private/server/manual-profile",
        },
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
      expect(terminalRecord).not.toHaveProperty("requestIdentity");
      expect(terminalRecord).not.toHaveProperty("browserConfig");
      expect(terminalRecord).not.toHaveProperty("leaseExpiresAt");
      const raw = await readFile(store.recordPath(transactionToken), "utf8");
      expect(raw).not.toContain("sensitive answer");
      expect(raw).not.toContain("/private/server");
      expect(raw).not.toContain("secret-target");
      expect(raw).not.toContain("acceptedPromptSha256");
      expect(raw).not.toContain("manual-profile");
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
        ...nonterminalAuthority,
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
