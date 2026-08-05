import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import {
  REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
} from "../../src/remote/types.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";
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

const modelSelection = {
  requestedModel: "GPT-5.6 Sol",
  resolvedLabel: "GPT-5.6 Sol",
  strategy: "select" as const,
  status: "switched" as const,
  verified: true,
  source: "chatgpt-model-picker" as const,
  capturedAt: "2026-01-01T00:00:00.000Z",
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
    acceptedPromptSha256: ["a".repeat(64)],
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

  test("persists settlement runtime only for the exact bound mode and controller generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-settlement-runtime-"));
    const transactionToken = "7".repeat(64);
    const controllerGeneration = "settlement-controller-generation";
    const finalizeRuntime: BrowserRuntimeMetadata = {
      ...runtime,
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    const abortRuntime: BrowserRuntimeMetadata = {
      ...runtime,
      recoveryCleanupResult: { status: "pending", settlementMode: "abort" },
    };
    try {
      const store = await RemoteTransactionStore.open({
        directory: root,
        controllerGeneration,
      });
      await begin(store, transactionToken);
      await expect(
        store.persistSettlementRuntime(transactionToken, finalizeRuntime),
      ).rejects.toThrow("transaction in state running");
      await publish(store, transactionToken);

      await expect(
        store.persistSettlementRuntime(transactionToken, finalizeRuntime),
      ).rejects.toThrow("durable settlement binding");
      await store.bindSettlement({
        transactionToken,
        mode: "finalize",
        durablePublication: true,
      });
      await expect(store.persistSettlementRuntime(transactionToken, abortRuntime)).rejects.toThrow(
        "exact durable settlement mode",
      );

      const staleStore = await RemoteTransactionStore.open({
        directory: root,
        controllerGeneration: "stale-settlement-controller",
      });
      await expect(
        staleStore.persistSettlementRuntime(transactionToken, finalizeRuntime),
      ).rejects.toThrow("stale remote controller generation");

      await expect(
        store.persistSettlementRuntime(transactionToken, finalizeRuntime),
      ).resolves.toMatchObject({
        state: "pending",
        settlementMode: "finalize",
        runtime: {
          recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
        },
        runtimeJournaledAt: expect.any(String),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects settlement binding that conflicts with the persisted runtime mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-runtime-mode-"));
    const transactionToken = "6".repeat(64);
    const abortRuntime: BrowserRuntimeMetadata = {
      ...runtime,
      recoveryCleanupResult: { status: "pending", settlementMode: "abort" },
    };
    try {
      const store = await RemoteTransactionStore.open({ directory: root });
      await begin(store, transactionToken);
      await store.publishCapture({
        transactionToken,
        runId: "run-1",
        result: capturedResult,
        runtime: abortRuntime,
        artifacts: [],
      });

      await expect(
        store.bindSettlement({
          transactionToken,
          mode: "finalize",
          durablePublication: true,
        }),
      ).rejects.toMatchObject({ code: "transaction_settlement_conflict" });
      await expect(store.read(transactionToken)).resolves.toMatchObject({
        state: "pending",
        runtime: { recoveryCleanupResult: { settlementMode: "abort" } },
      });
      await expect(
        store.bindSettlement({
          transactionToken,
          mode: "abort",
          durablePublication: false,
        }),
      ).resolves.toMatchObject({
        status: "bound",
        record: {
          settlementMode: "abort",
          runtime: { recoveryCleanupResult: { settlementMode: "abort" } },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("failure recording preserves an exact staged capture for publication retry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-staged-failure-"));
    const transactionToken = "5".repeat(64);
    try {
      const store = await RemoteTransactionStore.open({ directory: root });
      await begin(store, transactionToken);
      await store.stageCapture({
        transactionToken,
        runId: "run-1",
        result: capturedResult,
        runtime,
      });
      await expect(
        store.recordRecoverableFailure({
          transactionToken,
          runtime,
          error: failure(true),
        }),
      ).resolves.toMatchObject({
        state: "recoverable-error",
        result: undefined,
        stagedCapture: {
          result: capturedResult,
          runtime,
          stagedAt: expect.any(String),
        },
      });
      await expect(
        store.promoteStagedCapture({
          transactionToken,
          warning: {
            code: "remote-publication-retry-recovered",
            message: "Published from the durable exact staged capture.",
          },
        }),
      ).resolves.toMatchObject({
        state: "pending",
        result: {
          answerText: "captured",
          warnings: [
            {
              code: "remote-publication-retry-recovered",
              severity: "warning",
              message: "Published from the durable exact staged capture.",
            },
          ],
        },
        stagedCapture: undefined,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps exact staged identity stable across JSON omission of optional fields", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-staged-json-"));
    const transactionToken = "6".repeat(64);
    const optionalModelSelection = { ...modelSelection, requestedModel: undefined };
    const result = {
      ...capturedResult,
      answerHtml: undefined,
      modelSelection: optionalModelSelection,
    };
    try {
      const store = await RemoteTransactionStore.open({ directory: root });
      await begin(store, transactionToken);
      await store.stageCapture({
        transactionToken,
        runId: "run-1",
        result,
        runtime,
        modelSelection: optionalModelSelection,
      });
      await expect(
        store.stageCapture({
          transactionToken,
          runId: "run-1",
          result,
          runtime,
          modelSelection: optionalModelSelection,
        }),
      ).resolves.toMatchObject({ state: "running", stagedCapture: { result: capturedResult } });
      await expect(
        store.publishCapture({
          transactionToken,
          runId: "run-1",
          result,
          runtime,
          modelSelection: optionalModelSelection,
        }),
      ).resolves.toMatchObject({ state: "pending", result: capturedResult });
      const published = await store.read(transactionToken);
      expect(published).not.toHaveProperty("stagedCapture");
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
      name: "conflicting recoverable settlement runtime",
      setup: async (store, token) => {
        await begin(store, token);
        await store.recordRecoverableFailure({
          transactionToken: token,
          runtime,
          error: failure(true),
        });
        await store.bindSettlement({
          transactionToken: token,
          mode: "abort",
          durablePublication: false,
        });
      },
      act: async (store, token) =>
        store.persistSettlementRuntime(token, {
          ...runtime,
          recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
        }),
      message: "exact durable settlement mode",
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

  test("durably replaces recovery acquisition runtime under the recovered controller", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-recovery-runtime-store-"));
    const transactionToken = "d".repeat(64);
    const previousControllerGeneration = "controller-before-recovery";
    const recoveryControllerGeneration = "controller-after-recovery";
    const profileDirectory = {
      version: 1 as const,
      platform: process.platform,
      canonicalPath: "/tmp/oracle-recovery-runtime",
      device: "1",
      inode: "2",
    };
    const preIntent: BrowserRuntimeMetadata = {
      browserTransport: "cdp",
      chromeHost: "127.0.0.1",
      chromeProfileRoot: "/tmp/oracle-recovery-runtime",
      userDataDir: "/tmp/oracle-recovery-runtime",
      conversationId: committedPromptEpoch.conversationId,
      promptEpoch: committedPromptEpoch,
      recoveryCleanupResources: [
        {
          chromeHost: "127.0.0.1",
          chromeProfileRoot: "/tmp/oracle-recovery-runtime",
          userDataDir: "/tmp/oracle-recovery-runtime",
          conversationId: committedPromptEpoch.conversationId,
          promptEpoch: committedPromptEpoch,
          tabLease: { id: "recovery-lease", profileDirectory },
          acquisition: {
            generationId: "recovery-acquisition",
            pendingResource: "tab-lease",
            targetMarkerUrl: "about:blank#oracle-acquisition=recovery-acquisition",
          },
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "temporary",
            keepBrowser: false,
            closeOwnedTargetOnComplete: false,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
    const acquiredProcess: BrowserRuntimeMetadata = {
      ...preIntent,
      chromePid: 4242,
      chromePort: 9222,
      chromeProcessIdentity: {
        pid: 4242,
        processStartTime: "123",
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        normalizedUserDataDir: "/tmp/oracle-recovery-runtime",
        launchNonce: "recovery-process",
        profileDirectory,
      },
      recoveryCleanupResources: [
        {
          ...preIntent.recoveryCleanupResources![0],
          chromePid: 4242,
          chromePort: 9222,
          chromeProcessIdentity: {
            pid: 4242,
            processStartTime: "123",
            executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            normalizedUserDataDir: "/tmp/oracle-recovery-runtime",
            launchNonce: "recovery-process",
            profileDirectory,
          },
          profileDirectoryIdentity: profileDirectory,
          acquisition: {
            generationId: "recovery-acquisition",
            pendingResource: "chrome-target",
            targetMarkerUrl: "about:blank#oracle-acquisition=recovery-acquisition",
          },
        },
      ],
    };
    const acquiredTarget: BrowserRuntimeMetadata = {
      ...acquiredProcess,
      chromeTargetId: "recovery-target",
      recoveryCleanupResources: [
        {
          ...acquiredProcess.recoveryCleanupResources![0],
          chromeTargetId: "recovery-target",
          acquisition: {
            generationId: "recovery-acquisition",
            targetMarkerUrl: "about:blank#oracle-acquisition=recovery-acquisition",
          },
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "temporary",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
    };
    try {
      const initial = await RemoteTransactionStore.open({
        directory: root,
        controllerGeneration: previousControllerGeneration,
      });
      await begin(initial, transactionToken);
      await initial.journalRuntime(transactionToken, preIntent);

      const recovered = await RemoteTransactionStore.open({
        directory: root,
        controllerGeneration: recoveryControllerGeneration,
      });
      await recovered.reconcileStaleRunningRecords({
        buildError: (_record, hadRuntimeAuthority) => failure(hadRuntimeAuthority),
      });

      const assertDurablyReloaded = async (expected: BrowserRuntimeMetadata) => {
        const reloaded = await RemoteTransactionStore.open({
          directory: root,
          controllerGeneration: recoveryControllerGeneration,
        });
        await expect(reloaded.read(transactionToken)).resolves.toMatchObject({
          state: "recoverable-error",
          controllerGeneration: recoveryControllerGeneration,
          runtime: expected,
          restartRecovery: {
            previousControllerGeneration,
            reason: "controller-generation-changed",
          },
          leaseExpiresAt: expect.any(String),
        });
        return reloaded;
      };

      await recovered.journalRecoveryRuntime(transactionToken, preIntent);
      const afterIntent = await assertDurablyReloaded(preIntent);
      await afterIntent.journalRecoveryRuntime(transactionToken, acquiredProcess);
      const afterProcess = await assertDurablyReloaded(acquiredProcess);
      await afterProcess.journalRecoveryRuntime(transactionToken, acquiredTarget);
      await assertDurablyReloaded(acquiredTarget);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects recovery runtime journaling outside its unbound current-controller state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-recovery-runtime-reject-"));
    const currentControllerGeneration = "controller-current";
    const boundToken = "c".repeat(64);
    const finalizedToken = "b".repeat(64);
    const staleToken = "a".repeat(64);
    try {
      const current = await RemoteTransactionStore.open({
        directory: root,
        controllerGeneration: currentControllerGeneration,
      });
      await begin(current, boundToken);
      await current.journalRuntime(boundToken, runtime);
      await current.recordRecoverableFailure({
        transactionToken: boundToken,
        runtime,
        error: failure(true),
      });
      await current.bindSettlement({
        transactionToken: boundToken,
        mode: "abort",
        durablePublication: false,
      });
      await expect(current.journalRecoveryRuntime(boundToken, runtime)).rejects.toThrow(
        "Cannot journal recovery runtime after cleanup settlement is bound",
      );

      await begin(current, finalizedToken);
      await current.journalRuntime(finalizedToken, runtime);
      await publish(current, finalizedToken);
      await current.bindSettlement({
        transactionToken: finalizedToken,
        mode: "finalize",
        durablePublication: true,
      });
      await current.completeSettlement({
        transactionToken: finalizedToken,
        mode: "finalize",
        finalization: { status: "completed", runtime },
      });
      await expect(current.journalRecoveryRuntime(finalizedToken, runtime)).rejects.toThrow(
        "Cannot journal recovery runtime for transaction in state finalized",
      );

      const stale = await RemoteTransactionStore.open({
        directory: root,
        controllerGeneration: "controller-stale",
      });
      await begin(stale, staleToken);
      await stale.journalRuntime(staleToken, runtime);
      await stale.recordRecoverableFailure({
        transactionToken: staleToken,
        runtime,
        error: failure(true),
      });
      await expect(current.journalRecoveryRuntime(staleToken, runtime)).rejects.toThrow(
        "Cannot journal recovery runtime from a stale remote controller generation",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reconciles stale running generations according to persisted runtime authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-reconcile-store-"));
    const runtimeToken = "1".repeat(64);
    const preAuthorityToken = "2".repeat(64);
    const acquisitionToken = "3".repeat(64);
    const acquisitionRuntime = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeProfileRoot: "/tmp/oracle-browser-acquisition",
      userDataDir: "/tmp/oracle-browser-acquisition",
      recoveryCleanupResources: [
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeProfileRoot: "/tmp/oracle-browser-acquisition",
          userDataDir: "/tmp/oracle-browser-acquisition",
          tabLease: {
            id: "planned-lease-id",
            profileDirectory: {
              version: 1 as const,
              platform: process.platform,
              canonicalPath: "/tmp/oracle-browser-acquisition",
              device: "1",
              inode: "2",
            },
          },
          acquisition: {
            generationId: "acquisition-generation",
            pendingResource: "tab-lease" as const,
            targetMarkerUrl: "about:blank#oracle-acquisition=acquisition-generation",
          },
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "manual-login" as const,
            keepBrowser: true,
            closeOwnedTargetOnComplete: false,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" as const },
    };
    try {
      const first = await RemoteTransactionStore.open({
        directory: root,
        controllerGeneration: "controller-generation-1",
      });
      await begin(first, runtimeToken);
      await first.journalRuntime(runtimeToken, runtime, modelSelection);
      await begin(first, preAuthorityToken);
      await begin(first, acquisitionToken);
      await first.journalRuntime(acquisitionToken, acquisitionRuntime);

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
        {
          transactionToken: acquisitionToken,
          previousControllerGeneration: "controller-generation-1",
          state: "recoverable-error",
          hadRuntimeAuthority: true,
        },
      ]);
      const recoveredRuntime = await restarted.read(runtimeToken);
      expect(recoveredRuntime).toMatchObject({
        state: "recoverable-error",
        runtime,
        restartRecovery: { previousControllerGeneration: "controller-generation-1" },
      });
      expect(recoveredRuntime).not.toHaveProperty("modelSelection");
      await restarted.bindSettlement({
        transactionToken: runtimeToken,
        mode: "abort",
        durablePublication: false,
      });
      await expect(
        restarted.completeSettlement({
          transactionToken: runtimeToken,
          mode: "abort",
          finalization: { status: "completed", runtime },
        }),
      ).resolves.toMatchObject({ state: "aborted" });
      await expect(restarted.read(acquisitionToken)).resolves.toMatchObject({
        state: "recoverable-error",
        runtime: acquisitionRuntime,
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
      await store.journalRuntime(runtimeToken, runtime, modelSelection);
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
      const expiredRuntime = await store.read(runtimeToken);
      expect(expiredRuntime).toMatchObject({
        state: "recoverable-error",
        settlementMode: "abort",
        runtime,
      });
      expect(expiredRuntime).not.toHaveProperty("modelSelection");
      await expect(
        store.completeSettlement({
          transactionToken: runtimeToken,
          mode: "abort",
          finalization: { status: "completed", runtime },
        }),
      ).resolves.toMatchObject({ state: "aborted" });
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
