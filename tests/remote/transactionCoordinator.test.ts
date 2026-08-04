import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import type { BrowserRunTransaction } from "../../src/browserMode.js";
import { RemoteTransactionCoordinator } from "../../src/remote/transactionCoordinator.js";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";

const runtime: BrowserRunTransaction["runtime"] = {
  chromeTargetId: "target-1",
  conversationId: "conversation-1",
  promptEpoch: {
    status: "committed",
    epochId: "epoch-1",
    promptSha256: "a".repeat(64),
    baselineTurns: 1,
    followUpOrdinal: 0,
    remainingFollowUps: 0,
    verifiedUserTurnIndex: 1,
    verifiedUserTurnId: "turn-1",
    verifiedUserMessageId: "message-1",
    conversationId: "conversation-1",
  },
  recoveryCleanupResources: [
    {
      chromeTargetId: "target-1",
      conversationId: "conversation-1",
      promptEpoch: {
        status: "committed",
        epochId: "epoch-1",
        promptSha256: "a".repeat(64),
        baselineTurns: 1,
        followUpOrdinal: 0,
        remainingFollowUps: 0,
        verifiedUserTurnIndex: 1,
        verifiedUserTurnId: "turn-1",
        verifiedUserMessageId: "message-1",
        conversationId: "conversation-1",
      },
      recoveryCleanup: {
        transport: "local",
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
      },
    },
  ],
};

const capturedResult = {
  answerText: "done",
  answerMarkdown: "done",
  tookMs: 1,
  answerTokens: 1,
  answerChars: 4,
};

async function createPendingStore(root: string, transactionToken: string) {
  const store = await RemoteTransactionStore.open({
    directory: root,
    controllerGeneration: "controller-generation-1",
  });
  const createdAt = new Date().toISOString();
  await store.create({
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    transactionToken,
    runId: "run-1",
    createdAt,
    updatedAt: createdAt,
    state: "pending",
    runtime,
    result: capturedResult,
  });
  return store;
}

describe("RemoteTransactionCoordinator", () => {
  test("retains live authority across pending settlement and retries only the bound mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-settlement-"));
    const transactionToken = "e".repeat(64);
    try {
      const store = await createPendingStore(root, transactionToken);
      const finalize = vi
        .fn<BrowserRunTransaction["finalize"]>()
        .mockResolvedValueOnce({
          status: "pending",
          runtime: {
            ...runtime,
            recoveryCleanupResult: { status: "failed", error: "target still closing" },
          },
          error: "target still closing",
        })
        .mockResolvedValueOnce({ status: "completed", runtime });
      const active: BrowserRunTransaction = {
        ...capturedResult,
        runtime,
        finalize,
        abort: vi.fn(async () => ({ status: "completed" as const, runtime })),
      };
      const retryCleanup = vi.fn(async () => ({ status: "completed" as const, runtime }));
      const coordinator = new RemoteTransactionCoordinator({
        transactionStore: store,
        retryCleanup,
      });
      coordinator.registerActive(transactionToken, active);

      await expect(
        coordinator.settle({ transactionToken, mode: "finalize", durablePublication: true }),
      ).resolves.toMatchObject({
        finalization: { status: "pending" },
        record: { state: "pending" },
      });
      expect(coordinator.hasActive(transactionToken)).toBe(true);
      expect(finalize).toHaveBeenCalledTimes(1);
      expect(retryCleanup).not.toHaveBeenCalled();

      await expect(
        coordinator.settle({ transactionToken, mode: "abort", durablePublication: false }),
      ).rejects.toMatchObject({ code: "transaction_settlement_conflict" });
      expect(active.abort).not.toHaveBeenCalled();

      await expect(
        coordinator.settle({ transactionToken, mode: "finalize", durablePublication: true }),
      ).resolves.toMatchObject({
        finalization: { status: "completed" },
        record: { state: "finalized" },
      });
      expect(finalize).toHaveBeenCalledTimes(2);
      expect(coordinator.hasActive(transactionToken)).toBe(false);
      const finalizedRecord = await store.read(transactionToken);
      expect(finalizedRecord).toMatchObject({
        state: "finalized",
        terminalAudit: {
          settlementMode: "finalize",
          publicationAcknowledgedAt: expect.any(String),
        },
      });
      expect(finalizedRecord).not.toHaveProperty("result");
      expect(finalizedRecord).not.toHaveProperty("runtime");
      expect(finalizedRecord).not.toHaveProperty("artifacts");
      expect(finalizedRecord).not.toHaveProperty("settlementMode");
      expect(finalizedRecord).not.toHaveProperty("publicationAcknowledgedAt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("prohibits finalization until every required artifact has a durable receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-required-artifact-"));
    const transactionToken = "f".repeat(64);
    try {
      const store = await createPendingStore(root, transactionToken);
      await store.update(transactionToken, (record) => {
        record.artifacts = [
          {
            transactionToken,
            canonicalPath: path.join(root, "sessions", "session-1", "artifacts", "result.zip"),
            fileIdentity: {
              device: "1",
              inode: "2",
              birthtimeNs: "3",
              ctimeNs: "4",
            },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            descriptor: {
              artifactId: "artifact-1",
              runId: "run-1",
              kind: "file",
              filename: "result.zip",
              mimeType: "application/zip",
              byteSize: 4,
              sha256: "b".repeat(64),
              sourceUrlKind: "browser-download",
              transferStatus: "ready",
              required: true,
            },
          },
        ];
      });
      const finalize = vi.fn(async () => ({ status: "completed" as const, runtime }));
      const coordinator = new RemoteTransactionCoordinator({
        transactionStore: store,
        retryCleanup: vi.fn(async () => ({ status: "completed" as const, runtime })),
      });
      coordinator.registerActive(transactionToken, {
        ...capturedResult,
        runtime,
        finalize,
        abort: vi.fn(async () => ({ status: "completed" as const, runtime })),
      });

      await expect(
        coordinator.settle({ transactionToken, mode: "finalize", durablePublication: true }),
      ).rejects.toMatchObject({ code: "required_artifact_delivery_incomplete" });
      expect(finalize).not.toHaveBeenCalled();
      const pendingRecord = await store.read(transactionToken);
      expect(pendingRecord).toMatchObject({ state: "pending" });

      await store.update(transactionToken, (record) => {
        const registration = record.artifacts?.[0];
        if (!registration) throw new Error("missing artifact registration");
        registration.deliveryReceipt = {
          receiptId: "c".repeat(64),
          deliveredAt: new Date().toISOString(),
          byteSize: 4,
          sha256: "b".repeat(64),
        };
      });
      await expect(
        coordinator.settle({ transactionToken, mode: "finalize", durablePublication: true }),
      ).resolves.toMatchObject({ record: { state: "finalized" } });
      expect(finalize).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
