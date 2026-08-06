import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import type { BrowserRunTransaction } from "../../src/browser/types.js";
import type { DurableRemoteArtifactRegistration } from "../../src/remote/transactionModel.js";
import { RemoteTransactionCoordinator } from "../../src/remote/transactionCoordinator.js";
import { settlementResponse } from "../../src/remote/transactionProtocol.js";
import {
  completedBrowserCaptureCleanup,
  createBrowserRunTransaction,
  type BrowserCaptureSettlementAdapters,
} from "../../src/browser/runLifecycle.js";
import { OwnedBrowserResourceTransaction } from "../../src/browser/ownedBrowserResources.js";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";
function openTransactionStore(
  options: Omit<Parameters<typeof RemoteTransactionStore.open>[0], "integrityKeyPath">,
) {
  return RemoteTransactionStore.open({
    ...options,
    integrityKeyPath: path.join(options.directory, ".test-integrity", "record.key"),
  });
}

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
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
        closeOwnedTargetOnComplete: true,
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

function artifact(transactionToken: string): DurableRemoteArtifactRegistration {
  return {
    transactionToken,
    canonicalPath: "/private/session/result.zip",
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
      filename: "result.zip",
      mimeType: "application/zip",
      byteSize: 4,
      sha256: "b".repeat(64),
      sourceUrlKind: "browser-download",
      transferStatus: "ready",
      required: true,
    },
  };
}

async function createPendingStore(
  root: string,
  transactionToken: string,
  artifacts: DurableRemoteArtifactRegistration[] = [],
) {
  const store = await openTransactionStore({
    directory: root,
    controllerGeneration: "controller-generation-1",
  });
  await store.begin({
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    transactionToken,
    runId: "run-1",
    createdAt: new Date().toISOString(),
    requestIdentity: {
      acceptedPromptSha256: ["a".repeat(64)],
      followUpOrdinal: 0,
      remainingFollowUps: 0,
    },
    browserConfig: {
      chatgptUrl: "https://chatgpt.com",
      url: "https://chatgpt.com",
    },
  });
  await store.publishCapture({
    transactionToken,
    runId: "run-1",
    result: capturedResult,
    runtime,
    artifacts,
  });
  return store;
}

describe("RemoteTransactionCoordinator", () => {
  test("binds before cleanup, retains live authority while pending, and retries only that mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-settlement-"));
    const transactionToken = "e".repeat(64);
    try {
      const store = await createPendingStore(root, transactionToken);
      const finalize = vi
        .fn<BrowserRunTransaction["finalize"]>()
        .mockRejectedValueOnce(new Error("target still closing"))
        .mockResolvedValueOnce({ status: "completed", runtime });
      const active: BrowserRunTransaction = {
        ...capturedResult,
        runtime,
        bindSettlement: vi.fn(async () => runtime),
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
        finalization: {
          status: "pending",
          runtime: {
            recoveryCleanupResult: {
              status: "failed",
              settlementMode: "finalize",
              error: "target still closing",
            },
          },
        },
        record: { state: "pending", settlementMode: "finalize" },
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
      if (!finalizedRecord?.finalization) throw new Error("missing terminal finalization");
      expect(settlementResponse(finalizedRecord, finalizedRecord.finalization)).toMatchObject({
        state: "finalized",
        settlementAuthority: { mode: "finalize", outcome: "completed", state: "finalized" },
      });
      expect(finalizedRecord).toMatchObject({
        state: "finalized",
        terminalAudit: {
          settlementMode: "finalize",
          publicationAcknowledgedAt: expect.any(String),
        },
      });
      expect(finalizedRecord).not.toHaveProperty("result");
      expect(finalizedRecord).not.toHaveProperty("runtime");
      expect(finalizedRecord).not.toHaveProperty("requestIdentity");
      expect(finalizedRecord).not.toHaveProperty("browserConfig");
      expect(finalizedRecord).not.toHaveProperty("leaseExpiresAt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a cleanup result that attempts to replace the bound settlement mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-result-mode-"));
    const transactionToken = "d".repeat(64);
    const conflictingRuntime: BrowserRunTransaction["runtime"] = {
      ...runtime,
      recoveryCleanupResult: { status: "failed", settlementMode: "abort", error: "wrong mode" },
    };
    try {
      const store = await createPendingStore(root, transactionToken);
      const finalize = vi.fn(async () => ({
        status: "pending" as const,
        runtime: conflictingRuntime,
        error: "wrong mode",
      }));
      const coordinator = new RemoteTransactionCoordinator({
        transactionStore: store,
        retryCleanup: vi.fn(async () => ({ status: "completed" as const, runtime })),
      });
      coordinator.registerActive(transactionToken, {
        ...capturedResult,
        runtime,
        bindSettlement: vi.fn(async () => runtime),
        finalize,
        abort: vi.fn(async () => ({ status: "completed" as const, runtime })),
      });

      await expect(
        coordinator.settle({ transactionToken, mode: "finalize", durablePublication: true }),
      ).rejects.toMatchObject({
        details: { code: "browser-run-lifecycle-settlement-conflict" },
      });
      expect(finalize).toHaveBeenCalledOnce();
      expect(coordinator.hasActive(transactionToken)).toBe(true);
      await expect(store.read(transactionToken)).resolves.toMatchObject({
        state: "pending",
        settlementMode: "finalize",
        runtime: { recoveryCleanupResult: { settlementMode: "finalize" } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not invoke browser finalization until required artifact receipts are durable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-required-artifact-"));
    const transactionToken = "f".repeat(64);
    try {
      const store = await createPendingStore(root, transactionToken, [artifact(transactionToken)]);
      const finalize = vi.fn(async () => ({ status: "completed" as const, runtime }));
      const coordinator = new RemoteTransactionCoordinator({
        transactionStore: store,
        retryCleanup: vi.fn(async () => ({ status: "completed" as const, runtime })),
      });
      coordinator.registerActive(transactionToken, {
        ...capturedResult,
        runtime,
        bindSettlement: vi.fn(async () => runtime),
        finalize,
        abort: vi.fn(async () => ({ status: "completed" as const, runtime })),
      });

      await expect(
        coordinator.settle({ transactionToken, mode: "finalize", durablePublication: true }),
      ).rejects.toMatchObject({ code: "required_artifact_delivery_incomplete" });
      expect(finalize).not.toHaveBeenCalled();
      await store.recordArtifactDelivery({
        transactionToken,
        artifactId: "artifact-1",
        receipt: {
          receiptId: "c".repeat(64),
          deliveredAt: new Date().toISOString(),
          byteSize: 4,
          sha256: "b".repeat(64),
        },
      });
      await expect(
        coordinator.settle({ transactionToken, mode: "finalize", durablePublication: true }),
      ).resolves.toMatchObject({ record: { state: "finalized" } });
      expect(finalize).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries cleanup without live controller authority using the exact persisted settlement mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-cleanup-mode-"));
    const abortToken = "1".repeat(64);
    const finalizeToken = "2".repeat(64);
    try {
      const store = await createPendingStore(root, abortToken);
      await createPendingStore(root, finalizeToken);
      const retryCleanup = vi.fn(
        async (
          _runtime: BrowserRunTransaction["runtime"],
          _mode: "finalize" | "abort",
          _ownerId: string,
        ) => ({
          status: "completed" as const,
          runtime,
        }),
      );
      const coordinator = new RemoteTransactionCoordinator({
        transactionStore: store,
        retryCleanup,
      });

      await expect(
        coordinator.settle({
          transactionToken: abortToken,
          mode: "abort",
          durablePublication: false,
        }),
      ).resolves.toMatchObject({ record: { state: "aborted" } });
      await expect(
        coordinator.settle({
          transactionToken: finalizeToken,
          mode: "finalize",
          durablePublication: true,
        }),
      ).resolves.toMatchObject({ record: { state: "finalized" } });

      expect(retryCleanup).toHaveBeenNthCalledWith(
        1,
        {
          ...runtime,
          recoveryCleanupResult: { status: "pending", settlementMode: "abort" },
        },
        "abort",
        abortToken,
      );
      expect(retryCleanup).toHaveBeenNthCalledWith(
        2,
        {
          ...runtime,
          recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
        },
        "finalize",
        finalizeToken,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("persists abort-bound recoverable authority before live cleanup and releases it when terminal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-recoverable-abort-"));
    const transactionToken = "3".repeat(64);
    try {
      const store = await openTransactionStore({
        directory: root,
        controllerGeneration: "controller-generation-1",
      });
      await store.begin({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        transactionToken,
        runId: "run-1",
        createdAt: new Date().toISOString(),
        requestIdentity: {
          acceptedPromptSha256: ["a".repeat(64)],
          followUpOrdinal: 0,
          remainingFollowUps: 0,
        },
        browserConfig: {
          chatgptUrl: "https://chatgpt.com",
          url: "https://chatgpt.com",
        },
      });
      await store.recordRecoverableFailure({
        transactionToken,
        runtime,
        error: {
          name: "BrowserAutomationError",
          category: "browser-automation",
          message: "Required artifact preparation failed after capture",
          code: "artifact-registration-failed",
          stage: "execute-browser",
          recoverableDisconnect: true,
        },
      });

      const settleResources = vi.fn<BrowserCaptureSettlementAdapters["settleResources"]>(
        async (mode, pendingRuntime) => {
          expect(mode).toBe("abort");
          await expect(store.read(transactionToken)).resolves.toMatchObject({
            state: "recoverable-error",
            settlementMode: "abort",
            runtime: {
              recoveryCleanupResult: { status: "pending", settlementMode: "abort" },
            },
          });
          return completedBrowserCaptureCleanup(pendingRuntime);
        },
      );
      const settlement = new OwnedBrowserResourceTransaction(
        {
          persistRuntime: async (pendingRuntime) => {
            await store.persistSettlementRuntime(transactionToken, pendingRuntime);
          },
          settleResources,
        },
        runtime,
      );
      const active = createBrowserRunTransaction(capturedResult, settlement);
      const coordinator = new RemoteTransactionCoordinator({
        transactionStore: store,
        retryCleanup: vi.fn(async () => ({ status: "completed" as const, runtime })),
      });
      coordinator.registerActive(transactionToken, active);

      await expect(
        coordinator.settle({
          transactionToken,
          mode: "abort",
          durablePublication: false,
        }),
      ).resolves.toMatchObject({
        finalization: { status: "completed" },
        record: { state: "aborted", terminalAudit: { settlementMode: "abort" } },
      });
      expect(settleResources).toHaveBeenCalledOnce();
      expect(coordinator.hasActive(transactionToken)).toBe(false);
      await expect(store.read(transactionToken)).resolves.toMatchObject({
        state: "aborted",
        terminalAudit: { settlementMode: "abort" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
