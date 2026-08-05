import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import {
  REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
} from "../../src/remote/types.js";
import type {
  DurableRemoteArtifactRegistration,
  DurableRemoteAutomationError,
} from "../../src/remote/transactionStore.js";
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

const runtime = {
  chromeTargetId: "target-1",
  conversationId: committedPromptEpoch.conversationId,
  promptEpoch: committedPromptEpoch,
  recoveryCleanupResources: [
    {
      chromeTargetId: "target-1",
      conversationId: committedPromptEpoch.conversationId,
      promptEpoch: committedPromptEpoch,
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "temporary" as const,
        keepBrowser: false,
        closeOwnedTargetOnComplete: true,
      },
    },
  ],
};

const capturedResult = {
  answerText: "captured",
  answerMarkdown: "captured",
  tookMs: 1,
  answerTokens: 1,
  answerChars: 8,
};

const authority = {
  requestIdentity: {
    acceptedPromptSha256: ["9".repeat(64)],
    followUpOrdinal: 0,
    remainingFollowUps: 0 as const,
  },
  browserConfig: { chatgptUrl: "https://chatgpt.com/" },
};

function failure(recoverableDisconnect: boolean): DurableRemoteAutomationError {
  return {
    name: "BrowserAutomationError",
    category: "browser-automation",
    message: recoverableDisconnect ? "browser disconnected" : "browser authority unavailable",
    stage: "remote-controller-restart",
    recoverableDisconnect,
  };
}

function registration(
  transactionToken: string,
  runId = "run-1",
): DurableRemoteArtifactRegistration {
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
      runId,
      kind: "file",
      filename: "result.bin",
      mimeType: "application/octet-stream",
      byteSize: 7,
      sha256: "b".repeat(64),
      sourceUrlKind: "browser-download",
      transferStatus: "ready",
      required: true,
    },
  };
}

async function begin(store: RemoteTransactionStore, transactionToken: string, runId = "run-1") {
  await store.begin({
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    transactionToken,
    runId,
    createdAt: new Date().toISOString(),
    ...authority,
  });
}

async function publish(
  store: RemoteTransactionStore,
  transactionToken: string,
  artifacts: DurableRemoteArtifactRegistration[] = [],
) {
  return await store.publishCapture({
    transactionToken,
    runId: "run-1",
    result: capturedResult,
    runtime,
    artifacts,
  });
}

describe("RemoteTransactionStore", () => {
  test("allows only the durable capture, receipt, finalize, and retry state machines", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-transition-store-"));
    const finalizedToken = "a".repeat(64);
    const retriedToken = "b".repeat(64);
    try {
      const store = await RemoteTransactionStore.open({ directory: root });
      await begin(store, finalizedToken);
      await store.journalRuntime(finalizedToken, runtime);
      await publish(store, finalizedToken, [registration(finalizedToken)]);
      const receipt = {
        receiptId: "c".repeat(64),
        deliveredAt: new Date().toISOString(),
        byteSize: 7,
        sha256: "b".repeat(64),
      };
      await expect(
        store.recordArtifactDelivery({
          transactionToken: finalizedToken,
          artifactId: "artifact-1",
          receipt,
        }),
      ).resolves.toEqual(receipt);
      await expect(
        store.recordArtifactDelivery({
          transactionToken: finalizedToken,
          artifactId: "artifact-1",
          receipt: { ...receipt, deliveredAt: new Date(Date.now() + 1_000).toISOString() },
        }),
      ).resolves.toEqual(receipt);
      await expect(
        store.bindSettlement({
          transactionToken: finalizedToken,
          mode: "finalize",
          durablePublication: true,
        }),
      ).resolves.toMatchObject({ status: "bound", record: { state: "pending" } });
      await expect(
        store.completeSettlement({
          transactionToken: finalizedToken,
          mode: "finalize",
          finalization: {
            status: "pending",
            runtime: {
              ...runtime,
              recoveryCleanupResult: { status: "failed", settlementMode: "finalize" },
            },
            error: "target still closing",
          },
        }),
      ).resolves.toMatchObject({ state: "pending", settlementMode: "finalize" });
      await expect(
        store.completeSettlement({
          transactionToken: finalizedToken,
          mode: "finalize",
          finalization: { status: "completed", runtime },
        }),
      ).resolves.toMatchObject({
        state: "finalized",
        terminalAudit: {
          settlementMode: "finalize",
          publicationAcknowledgedAt: expect.any(String),
        },
      });
      await expect(
        store.bindSettlement({
          transactionToken: finalizedToken,
          mode: "finalize",
          durablePublication: true,
        }),
      ).resolves.toMatchObject({ status: "completed" });

      await begin(store, retriedToken);
      await store.recordRecoverableFailure({
        transactionToken: retriedToken,
        runtime,
        error: failure(true),
      });
      await expect(publish(store, retriedToken)).resolves.toMatchObject({
        state: "pending",
        error: undefined,
      });
      await store.bindSettlement({
        transactionToken: retriedToken,
        mode: "abort",
        durablePublication: false,
      });
      await expect(
        store.completeSettlement({
          transactionToken: retriedToken,
          mode: "abort",
          finalization: { status: "completed", runtime: {} },
        }),
      ).resolves.toMatchObject({ state: "aborted", terminalAudit: { settlementMode: "abort" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves an unbound capture for restart and exposes only a durably bound shutdown mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-shutdown-store-"));
    const transactionToken = "0".repeat(64);
    try {
      const store = await RemoteTransactionStore.open({
        directory: root,
        controllerGeneration: "controller-before-shutdown",
      });
      await begin(store, transactionToken);
      await publish(store, transactionToken, [registration(transactionToken)]);
      const beforeShutdown = await readFile(store.recordPath(transactionToken), "utf8");

      await expect(store.prepareControllerShutdown(transactionToken)).resolves.toMatchObject({
        action: "preserve",
        record: {
          state: "pending",
          result: capturedResult,
          runtime,
          artifacts: [{ descriptor: { artifactId: "artifact-1" } }],
        },
      });
      await expect(readFile(store.recordPath(transactionToken), "utf8")).resolves.toBe(
        beforeShutdown,
      );

      await store.recordArtifactDelivery({
        transactionToken,
        artifactId: "artifact-1",
        receipt: {
          receiptId: "1".repeat(64),
          deliveredAt: new Date().toISOString(),
          byteSize: 7,
          sha256: "b".repeat(64),
        },
      });
      await store.bindSettlement({
        transactionToken,
        mode: "finalize",
        durablePublication: true,
      });
      await expect(store.prepareControllerShutdown(transactionToken)).resolves.toMatchObject({
        action: "settle",
        mode: "finalize",
        durablePublication: true,
        record: {
          state: "pending",
          settlementMode: "finalize",
          publicationAcknowledgedAt: expect.any(String),
        },
      });
      await expect(
        store.bindSettlement({
          transactionToken,
          mode: "abort",
          durablePublication: false,
        }),
      ).rejects.toMatchObject({ code: "transaction_settlement_conflict" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const rejectedTransitions: Array<{
    name: string;
    setup: (store: RemoteTransactionStore, token: string) => Promise<void>;
    act: (store: RemoteTransactionStore, token: string) => Promise<unknown>;
    message: string;
  }> = [
    {
      name: "capture with a changed run identity",
      setup: async (store, token) => begin(store, token),
      act: async (store, token) =>
        store.publishCapture({
          transactionToken: token,
          runId: "different-run",
          result: capturedResult,
          runtime,
        }),
      message: "run identity changed",
    },
    {
      name: "runtime journaling after capture",
      setup: async (store, token) => {
        await begin(store, token);
        await publish(store, token);
      },
      act: async (store, token) => store.journalRuntime(token, runtime),
      message: "Cannot journal runtime",
    },
    {
      name: "artifact receipt before capture",
      setup: async (store, token) => begin(store, token),
      act: async (store, token) =>
        store.recordArtifactDelivery({
          transactionToken: token,
          artifactId: "artifact-1",
          receipt: {
            receiptId: "d".repeat(64),
            deliveredAt: new Date().toISOString(),
            byteSize: 7,
            sha256: "b".repeat(64),
          },
        }),
      message: "Cannot record artifact delivery",
    },
    {
      name: "finalize without durable publication",
      setup: async (store, token) => {
        await begin(store, token);
        await publish(store, token);
      },
      act: async (store, token) =>
        store.bindSettlement({
          transactionToken: token,
          mode: "finalize",
          durablePublication: false,
        }),
      message: "Durable answer publication acknowledgement is required",
    },
    {
      name: "finalize without required artifact receipt",
      setup: async (store, token) => {
        await begin(store, token);
        await publish(store, token, [registration(token)]);
      },
      act: async (store, token) =>
        store.bindSettlement({
          transactionToken: token,
          mode: "finalize",
          durablePublication: true,
        }),
      message: "required artifact delivery receipt",
    },
    {
      name: "conflicting settlement mode",
      setup: async (store, token) => {
        await begin(store, token);
        await publish(store, token);
        await store.bindSettlement({
          transactionToken: token,
          mode: "abort",
          durablePublication: false,
        });
      },
      act: async (store, token) =>
        store.bindSettlement({
          transactionToken: token,
          mode: "finalize",
          durablePublication: true,
        }),
      message: "already bound to abort",
    },
    {
      name: "settlement completion without durable binding",
      setup: async (store, token) => {
        await begin(store, token);
        await publish(store, token);
      },
      act: async (store, token) =>
        store.completeSettlement({
          transactionToken: token,
          mode: "abort",
          finalization: { status: "completed", runtime },
        }),
      message: "exact durable settlement binding",
    },
    {
      name: "failure that discards journaled runtime",
      setup: async (store, token) => {
        await begin(store, token);
        await store.journalRuntime(token, runtime);
      },
      act: async (store, token) =>
        store.recordRecoverableFailure({ transactionToken: token, error: failure(false) }),
      message: "Cannot discard journaled runtime authority",
    },
    {
      name: "finalize of recoverable authority without a capture",
      setup: async (store, token) => {
        await begin(store, token);
        await store.recordRecoverableFailure({
          transactionToken: token,
          runtime,
          error: failure(true),
        });
      },
      act: async (store, token) =>
        store.bindSettlement({
          transactionToken: token,
          mode: "finalize",
          durablePublication: true,
        }),
      message: "no durably captured answer",
    },
  ];

  for (const scenario of rejectedTransitions) {
    test(`rejects ${scenario.name}`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-rejected-transition-"));
      const token = "e".repeat(64);
      try {
        const store = await RemoteTransactionStore.open({ directory: root });
        await scenario.setup(store, token);
        await expect(scenario.act(store, token)).rejects.toThrow(scenario.message);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test("reconciles stale running generations according to persisted runtime authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-reconcile-store-"));
    const runtimeToken = "1".repeat(64);
    const preAuthorityToken = "2".repeat(64);
    try {
      const first = await RemoteTransactionStore.open({
        directory: root,
        controllerGeneration: "controller-generation-1",
      });
      await begin(first, runtimeToken);
      await first.journalRuntime(runtimeToken, runtime);
      await begin(first, preAuthorityToken);

      const restarted = await RemoteTransactionStore.open({
        directory: root,
        controllerGeneration: "controller-generation-2",
      });
      await expect(
        restarted.reconcileStaleRunningRecords({
          buildError: (_record, hadRuntimeAuthority) => failure(hadRuntimeAuthority),
        }),
      ).resolves.toEqual([
        {
          transactionToken: runtimeToken,
          previousControllerGeneration: "controller-generation-1",
          state: "recoverable-error",
          hadRuntimeAuthority: true,
        },
        {
          transactionToken: preAuthorityToken,
          previousControllerGeneration: "controller-generation-1",
          state: "failed",
          hadRuntimeAuthority: false,
        },
      ]);
      await expect(restarted.read(runtimeToken)).resolves.toMatchObject({
        state: "recoverable-error",
        runtime,
        restartRecovery: { previousControllerGeneration: "controller-generation-1" },
      });
      await expect(restarted.read(preAuthorityToken)).resolves.toMatchObject({
        state: "failed",
        terminalAudit: { errorStage: "remote-controller-restart" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("expires authority atomically from the exact observed lease", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-expiry-store-"));
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const runtimeToken = "3".repeat(64);
    const preAuthorityToken = "4".repeat(64);
    try {
      const store = await RemoteTransactionStore.open({
        directory: root,
        leaseDurationMs: 1_000,
        now: () => now,
      });
      await begin(store, runtimeToken);
      await store.journalRuntime(runtimeToken, runtime);
      await begin(store, preAuthorityToken);
      const runtimeLease = (await store.read(runtimeToken))?.leaseExpiresAt;
      const preAuthorityLease = (await store.read(preAuthorityToken))?.leaseExpiresAt;
      if (!runtimeLease || !preAuthorityLease) throw new Error("missing leases");
      now += 1_001;

      await expect(
        store.expire({
          transactionToken: runtimeToken,
          expectedLeaseExpiresAt: runtimeLease,
          buildError: (_record, hadRuntimeAuthority) => failure(hadRuntimeAuthority),
        }),
      ).resolves.toEqual({ mode: "abort", durablePublication: false });
      await expect(store.read(runtimeToken)).resolves.toMatchObject({
        state: "recoverable-error",
        settlementMode: "abort",
      });
      await expect(
        store.expire({
          transactionToken: preAuthorityToken,
          expectedLeaseExpiresAt: preAuthorityLease,
          buildError: (_record, hadRuntimeAuthority) => failure(hadRuntimeAuthority),
        }),
      ).resolves.toBeNull();
      await expect(store.read(preAuthorityToken)).resolves.toMatchObject({ state: "failed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("enforces capacity and publishes begin records atomically without overwriting tokens", async () => {
    const capacityRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-capacity-store-"));
    try {
      const store = await RemoteTransactionStore.open({
        directory: capacityRoot,
        maximumRecords: 1,
      });
      await begin(store, "5".repeat(64));
      await expect(begin(store, "6".repeat(64))).rejects.toBeInstanceOf(
        RemoteTransactionCapacityError,
      );
      await expect(store.list()).resolves.toHaveLength(1);
      expect((await store.read("5".repeat(64)))?.capacityReservationBytes).toBe(
        REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES,
      );
    } finally {
      await rm(capacityRoot, { recursive: true, force: true });
    }

    const byteRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-byte-store-"));
    try {
      const store = await RemoteTransactionStore.open({ directory: byteRoot, maximumBytes: 64 });
      await expect(begin(store, "7".repeat(64))).rejects.toBeInstanceOf(
        RemoteTransactionCapacityError,
      );
    } finally {
      await rm(byteRoot, { recursive: true, force: true });
    }

    const atomicRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-atomic-store-"));
    const interruptedToken = "8".repeat(64);
    const duplicateToken = "9".repeat(64);
    const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    const link = vi.fn(actualFs.link);
    link.mockRejectedValueOnce(
      Object.assign(new Error("publication interrupted"), { code: "EINTR" }),
    );
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actualFs, link }));
    // The mocked built-in ESM export requires a test-isolated module reload.
    const { RemoteTransactionStore: IsolatedRemoteTransactionStore } =
      await import("../../src/remote/transactionStore.js");
    try {
      const store = await IsolatedRemoteTransactionStore.open({ directory: atomicRoot });
      await expect(
        store.begin({
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          transactionToken: interruptedToken,
          runId: "run-1",
          createdAt: new Date().toISOString(),
          ...authority,
        }),
      ).rejects.toMatchObject({ code: "EINTR" });
      await expect(fs.access(store.recordPath(interruptedToken))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readdir(atomicRoot)).toEqual([]);

      await store.begin({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        transactionToken: duplicateToken,
        runId: "run-1",
        createdAt: new Date().toISOString(),
        ...authority,
      });
      const original = await readFile(store.recordPath(duplicateToken), "utf8");
      await expect(
        store.begin({
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          transactionToken: duplicateToken,
          runId: "replacement",
          createdAt: new Date().toISOString(),
          ...authority,
        }),
      ).rejects.toMatchObject({ code: "EEXIST" });
      await expect(readFile(store.recordPath(duplicateToken), "utf8")).resolves.toBe(original);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await rm(atomicRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test("redacts terminal authority and prunes it after retention", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-terminal-store-"));
    const transactionToken = "f".repeat(64);
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    try {
      const store = await RemoteTransactionStore.open({
        directory: root,
        terminalRetentionMs: 1_000,
        now: () => now,
      });
      await begin(store, transactionToken);
      await publish(store, transactionToken, [registration(transactionToken)]);
      await store.bindSettlement({
        transactionToken,
        mode: "abort",
        durablePublication: false,
      });
      await store.completeSettlement({
        transactionToken,
        mode: "abort",
        finalization: { status: "completed", runtime },
      });

      const terminalRecord = await store.read(transactionToken);
      expect(terminalRecord).toMatchObject({
        state: "aborted",
        finalization: { status: "completed", runtime: { promptEpoch: committedPromptEpoch } },
        terminalAudit: {
          settlementMode: "abort",
          artifacts: [{ artifactId: "artifact-1", required: true }],
        },
      });
      expect(terminalRecord).not.toHaveProperty("result");
      expect(terminalRecord).not.toHaveProperty("runtime");
      expect(terminalRecord).not.toHaveProperty("requestIdentity");
      expect(terminalRecord).not.toHaveProperty("browserConfig");
      expect(terminalRecord).not.toHaveProperty("leaseExpiresAt");
      const raw = await readFile(store.recordPath(transactionToken), "utf8");
      expect(raw).not.toContain("captured");
      expect(raw).not.toContain("/private/server");
      expect(raw).not.toContain("target-1");

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
