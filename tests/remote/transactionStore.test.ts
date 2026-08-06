import { createHmac } from "node:crypto";
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
} from "../../src/remote/transactionModel.js";
import {
  RemoteTransactionCapacityError,
  RemoteTransactionRecordIntegrityError,
  RemoteTransactionStore,
} from "../../src/remote/transactionStore.js";
import { processIdentity } from "../browser/chromeLifecycleTestHelpers.js";
function openTransactionStore(
  options: Omit<Parameters<typeof RemoteTransactionStore.open>[0], "integrityKeyPath">,
) {
  return RemoteTransactionStore.open({
    ...options,
    integrityKeyPath: path.join(options.directory, ".test-integrity", "record.key"),
  });
}

type TestTransactionEnvelope = {
  version: number;
  algorithm: string;
  keyId: string;
  revision: number;
  payload: string;
  mac: string;
};

async function readTransactionEnvelope(
  store: RemoteTransactionStore,
  transactionToken: string,
): Promise<TestTransactionEnvelope> {
  return JSON.parse(
    await readFile(store.recordPath(transactionToken), "utf8"),
  ) as TestTransactionEnvelope;
}

function recomputeEnvelopeMac(params: {
  envelope: TestTransactionEnvelope;
  integrityKey: Buffer;
  directory: string;
  transactionToken: string;
}): string {
  const payload = Buffer.from(params.envelope.payload, "base64");
  const header = Buffer.from(
    JSON.stringify([
      "oracle.remote-controller.transaction-store.record.v1",
      params.envelope.version,
      params.envelope.algorithm,
      params.envelope.keyId,
      path.resolve(params.directory),
      params.transactionToken,
      params.envelope.revision,
      payload.byteLength,
    ]),
    "utf8",
  );
  return createHmac("sha256", params.integrityKey)
    .update(header)
    .update(Buffer.of(0))
    .update(payload)
    .digest("hex");
}

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
  chromeHost: "service.example",
  chromePort: 9222,
  chromeBrowserWSEndpoint: "ws://service.example:9222/devtools/browser/store-generation",
  chromeTargetId: "target-1",
  conversationId: committedPromptEpoch.conversationId,
  promptEpoch: committedPromptEpoch,
  recoveryCleanupResources: [
    {
      chromeHost: "service.example",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://service.example:9222/devtools/browser/store-generation",
      chromeTargetId: "target-1",
      targetCloseCapability: {
        version: 1 as const,
        generationId: "store-generation",
        capabilityId: "store-capability",
        targetId: "target-1",
        browserWSEndpoint: "ws://service.example:9222/devtools/browser/store-generation",
      },
      acquisition: { generationId: "store-generation" },
      conversationId: committedPromptEpoch.conversationId,
      promptEpoch: committedPromptEpoch,
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "none" as const,
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
      const store = await openTransactionStore({ directory: root });
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
      await store.beginSettlementExecution({
        transactionToken: finalizedToken,
        mode: "finalize",
      });
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
      await expect(
        store.bindSettlement({
          transactionToken: finalizedToken,
          mode: "abort",
          durablePublication: false,
        }),
      ).rejects.toMatchObject({
        code: "transaction_already_settled",
        settlementAuthority: {
          mode: "finalize",
          outcome: "completed",
          state: "finalized",
        },
      });

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
      await store.beginSettlementExecution({
        transactionToken: retriedToken,
        mode: "abort",
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
      const store = await openTransactionStore({
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

      const staleStore = await openTransactionStore({
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
      const store = await openTransactionStore({ directory: root });
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
      ).rejects.toMatchObject({
        code: "transaction_settlement_conflict",
        settlementAuthority: { mode: "abort", outcome: "bound", state: "pending" },
      });
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
      const store = await openTransactionStore({ directory: root });
      await begin(store, transactionToken);
      await store.stageCapture({
        transactionToken,
        runId: "run-1",
        result: capturedResult,
        runtime,
        artifacts: [],
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
        artifacts: [],
        stagedCapture: undefined,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never promotes an artifact-bearing stage before its durable manifest is complete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-incomplete-manifest-"));
    const transactionToken = "4".repeat(64);
    try {
      const store = await openTransactionStore({ directory: root });
      await begin(store, transactionToken);
      await store.stageCapture({
        transactionToken,
        runId: "run-1",
        result: capturedResult,
        runtime,
      });
      await store.recordRecoverableFailure({
        transactionToken,
        runtime,
        error: failure(true),
      });

      await expect(store.promoteStagedCapture({ transactionToken })).rejects.toMatchObject({
        code: "staged_capture_artifact_manifest_incomplete",
      });
      await expect(
        store.stageCapture({
          transactionToken,
          runId: "run-1",
          result: capturedResult,
          runtime,
          artifacts: [],
        }),
      ).rejects.toMatchObject({ code: "staged_capture_artifact_manifest_incomplete" });
      await expect(store.read(transactionToken)).resolves.toMatchObject({
        state: "recoverable-error",
        stagedCapture: { result: capturedResult },
      });
      expect((await store.read(transactionToken))?.stagedCapture).not.toHaveProperty("artifacts");
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
      const store = await openTransactionStore({ directory: root });
      await begin(store, transactionToken);
      await store.stageCapture({
        transactionToken,
        runId: "run-1",
        result,
        runtime,
        modelSelection: optionalModelSelection,
        artifacts: [],
      });
      await expect(
        store.stageCapture({
          transactionToken,
          runId: "run-1",
          result,
          runtime,
          modelSelection: optionalModelSelection,
          artifacts: [],
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
    const baseChromeProcessIdentity = processIdentity(
      path.join(root, "temporary-profile"),
      4323,
      "10000000-0000-4000-8000-000000000003",
    );
    const chromeProcessIdentity = {
      ...baseChromeProcessIdentity,
      launchClaim: {
        ...baseChromeProcessIdentity.launchClaim,
        generationId: "store-generation",
      },
    };
    const restartDurableRuntime: BrowserRuntimeMetadata = {
      ...runtime,
      chromeProcessIdentity,
      chromePid: chromeProcessIdentity.pid,
      chromeProfileRoot: path.join(root, "temporary-profile"),
      userDataDir: path.join(root, "temporary-profile"),
      recoveryCleanupResources: runtime.recoveryCleanupResources.map((resource) => ({
        ...resource,
        chromeProcessIdentity,
        chromePid: chromeProcessIdentity.pid,
        profileDirectoryIdentity: chromeProcessIdentity.profileDirectory,
        chromeProfileRoot: path.join(root, "temporary-profile"),
        userDataDir: path.join(root, "temporary-profile"),
        acquisition: {
          generationId: chromeProcessIdentity.launchClaim.generationId,
          processLaunchClaim: chromeProcessIdentity.launchClaim,
        },
        recoveryCleanup: {
          ...resource.recoveryCleanup,
          profileKind: "temporary",
          keepBrowser: false,
        },
      })),
    };
    try {
      const store = await openTransactionStore({
        directory: root,
        controllerGeneration: "controller-before-shutdown",
      });
      await begin(store, transactionToken);
      await store.publishCapture({
        transactionToken,
        runId: "run-1",
        result: capturedResult,
        runtime: restartDurableRuntime,
        artifacts: [registration(transactionToken)],
      });
      const beforeShutdown = await readFile(store.recordPath(transactionToken), "utf8");

      await expect(store.prepareControllerShutdown(transactionToken)).resolves.toMatchObject({
        action: "preserve",
        record: {
          state: "pending",
          result: capturedResult,
          runtime: restartDurableRuntime,
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

  test("blocks shutdown while a manual kept target depends on live-only close authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-shutdown-block-store-"));
    const transactionToken = "9".repeat(64);
    const baseChromeProcessIdentity = processIdentity(
      path.join(root, "manual-profile"),
      4324,
      "10000000-0000-4000-8000-000000000004",
    );
    const chromeProcessIdentity = {
      ...baseChromeProcessIdentity,
      launchClaim: {
        ...baseChromeProcessIdentity.launchClaim,
        generationId: "store-generation",
      },
    };
    const liveOnlyRuntime: BrowserRuntimeMetadata = {
      ...runtime,
      chromeProcessIdentity,
      chromePid: chromeProcessIdentity.pid,
      chromeProfileRoot: path.join(root, "manual-profile"),
      userDataDir: path.join(root, "manual-profile"),
      recoveryCleanupResources: runtime.recoveryCleanupResources.map((resource) => ({
        ...resource,
        chromeProcessIdentity,
        chromePid: chromeProcessIdentity.pid,
        profileDirectoryIdentity: chromeProcessIdentity.profileDirectory,
        chromeProfileRoot: path.join(root, "manual-profile"),
        userDataDir: path.join(root, "manual-profile"),
        recoveryCleanup: {
          ...resource.recoveryCleanup,
          profileKind: "manual-login",
          keepBrowser: true,
        },
      })),
    };
    try {
      const store = await openTransactionStore({ directory: root });
      await begin(store, transactionToken);
      await store.publishCapture({
        transactionToken,
        runId: "run-1",
        result: capturedResult,
        runtime: liveOnlyRuntime,
        artifacts: [],
      });
      const beforeShutdown = await readFile(store.recordPath(transactionToken), "utf8");
      await expect(store.prepareControllerShutdown(transactionToken)).rejects.toThrow(
        "durable capture depends on non-restart-durable browser cleanup authority",
      );
      await expect(readFile(store.recordPath(transactionToken), "utf8")).resolves.toBe(
        beforeShutdown,
      );
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
      name: "finalize execution without durable publication",
      setup: async (store, token) => {
        await begin(store, token);
        await publish(store, token);
        await store.bindSettlement({
          transactionToken: token,
          mode: "finalize",
          durablePublication: false,
        });
      },
      act: async (store, token) =>
        store.beginSettlementExecution({ transactionToken: token, mode: "finalize" }),
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
        const store = await openTransactionStore({ directory: root });
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
      version: 2 as const,
      platform: process.platform,
      canonicalPath: "/tmp/oracle-recovery-runtime",
      device: "1",
      inode: "2",
      birthtimeNs: "3",
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
      const initial = await openTransactionStore({
        directory: root,
        controllerGeneration: previousControllerGeneration,
      });
      await begin(initial, transactionToken);
      await initial.journalRuntime(transactionToken, preIntent);

      const recovered = await openTransactionStore({
        directory: root,
        controllerGeneration: recoveryControllerGeneration,
      });
      await recovered.reconcileStaleRunningRecords({
        buildError: (_record, hadRuntimeAuthority) => failure(hadRuntimeAuthority),
      });

      const assertDurablyReloaded = async (expected: BrowserRuntimeMetadata) => {
        const reloaded = await openTransactionStore({
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
      const current = await openTransactionStore({
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
      await current.beginSettlementExecution({
        transactionToken: finalizedToken,
        mode: "finalize",
      });
      await current.completeSettlement({
        transactionToken: finalizedToken,
        mode: "finalize",
        finalization: { status: "completed", runtime },
      });
      await expect(current.journalRecoveryRuntime(finalizedToken, runtime)).rejects.toThrow(
        "Cannot journal recovery runtime for transaction in state finalized",
      );

      const stale = await openTransactionStore({
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
              version: 2 as const,
              platform: process.platform,
              canonicalPath: "/tmp/oracle-browser-acquisition",
              device: "1",
              inode: "2",
              birthtimeNs: "3",
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
      const first = await openTransactionStore({
        directory: root,
        controllerGeneration: "controller-generation-1",
      });
      await begin(first, runtimeToken);
      await first.journalRuntime(runtimeToken, runtime, modelSelection);
      await begin(first, preAuthorityToken);
      await begin(first, acquisitionToken);
      await first.journalRuntime(acquisitionToken, acquisitionRuntime);

      const restarted = await openTransactionStore({
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
      await restarted.beginSettlementExecution({
        transactionToken: runtimeToken,
        mode: "abort",
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

  test("seeds the controller-lifetime head from the authenticated record after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-integrity-restart-"));
    const directory = path.join(root, "transactions");
    const integrityKeyPath = path.join(root, "protected", "record-integrity.key");
    const transactionToken = "4".repeat(64);
    try {
      const first = await RemoteTransactionStore.open({
        directory,
        integrityKeyPath,
        controllerGeneration: "controller-before-integrity-restart",
      });
      await begin(first, transactionToken);
      await first.journalRuntime(transactionToken, runtime, modelSelection);
      const beforeRestart = await readTransactionEnvelope(first, transactionToken);
      expect(beforeRestart.revision).toBe(2);

      const restarted = await RemoteTransactionStore.open({
        directory,
        integrityKeyPath,
        controllerGeneration: "controller-after-integrity-restart",
      });
      await expect(restarted.read(transactionToken)).resolves.toMatchObject({
        transactionToken,
        state: "running",
        runtime,
        controllerGeneration: "controller-before-integrity-restart",
      });
      await expect(
        restarted.reconcileStaleRunningRecords({
          buildError: (_record, hadRuntimeAuthority) => failure(hadRuntimeAuthority),
        }),
      ).resolves.toEqual([
        {
          transactionToken,
          previousControllerGeneration: "controller-before-integrity-restart",
          state: "recoverable-error",
          hadRuntimeAuthority: true,
        },
      ]);
      expect((await readTransactionEnvelope(restarted, transactionToken)).revision).toBe(3);
      await restarted.journalRecoveryRuntime(transactionToken, runtime);
      expect((await readTransactionEnvelope(restarted, transactionToken)).revision).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a same-controller replay of an older signed revision before effects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-controller-replay-"));
    const transactionToken = "3".repeat(64);
    try {
      const store = await openTransactionStore({ directory: root });
      await begin(store, transactionToken);
      await publish(store, transactionToken);
      const olderBytes = await readFile(store.recordPath(transactionToken));
      const olderRevision = (JSON.parse(olderBytes.toString("utf8")) as TestTransactionEnvelope)
        .revision;
      await store.bindSettlement({
        transactionToken,
        mode: "finalize",
        durablePublication: true,
      });
      await store.beginSettlementExecution({ transactionToken, mode: "finalize" });
      await store.completeSettlement({
        transactionToken,
        mode: "finalize",
        finalization: { status: "completed", runtime },
      });
      const terminalBytes = await readFile(store.recordPath(transactionToken));
      const terminalRevision = (
        JSON.parse(terminalBytes.toString("utf8")) as TestTransactionEnvelope
      ).revision;
      expect(terminalRevision).toBeGreaterThan(olderRevision);
      const cleanup = vi.fn(async () => true);
      store.registerArtifactNamespaceCleanup(cleanup);

      await fs.writeFile(store.recordPath(transactionToken), olderBytes, { mode: 0o600 });
      await expect(
        store.bindSettlement({
          transactionToken,
          mode: "abort",
          durablePublication: false,
        }),
      ).rejects.toBeInstanceOf(RemoteTransactionRecordIntegrityError);
      expect(cleanup).not.toHaveBeenCalled();

      await fs.writeFile(store.recordPath(transactionToken), terminalBytes, { mode: 0o600 });
      await expect(store.read(transactionToken)).resolves.toMatchObject({ state: "finalized" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects recomputed forged envelopes and noncanonical or unauthenticated revisions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-controller-forgery-"));
    const directory = path.join(root, "transactions");
    const integrityKeyPath = path.join(root, "protected", "record-integrity.key");
    const transactionToken = "2".repeat(64);
    try {
      const store = await RemoteTransactionStore.open({ directory, integrityKeyPath });
      await begin(store, transactionToken);
      const originalBytes = await readFile(store.recordPath(transactionToken));
      const originalEnvelope = JSON.parse(
        originalBytes.toString("utf8"),
      ) as TestTransactionEnvelope;
      const integrityKey = await readFile(integrityKeyPath);

      const forgedEnvelope = structuredClone(originalEnvelope);
      const forgedPayload = JSON.parse(
        Buffer.from(forgedEnvelope.payload, "base64").toString("utf8"),
      ) as { browserConfig: { chatgptUrl?: string } };
      forgedPayload.browserConfig.chatgptUrl = "https://forged.invalid/";
      forgedEnvelope.payload = Buffer.from(`${JSON.stringify(forgedPayload, null, 2)}\n`).toString(
        "base64",
      );
      forgedEnvelope.mac = recomputeEnvelopeMac({
        envelope: forgedEnvelope,
        integrityKey,
        directory,
        transactionToken,
      });
      await fs.writeFile(
        store.recordPath(transactionToken),
        `${JSON.stringify(forgedEnvelope, null, 2)}\n`,
      );
      await expect(store.read(transactionToken)).rejects.toBeInstanceOf(
        RemoteTransactionRecordIntegrityError,
      );
      await fs.writeFile(store.recordPath(transactionToken), originalBytes, { mode: 0o600 });
      await expect(store.read(transactionToken)).resolves.toMatchObject({ transactionToken });

      const fractionalRevision = { ...originalEnvelope, revision: 1.5 };
      fractionalRevision.mac = recomputeEnvelopeMac({
        envelope: fractionalRevision,
        integrityKey,
        directory,
        transactionToken,
      });
      await fs.writeFile(
        store.recordPath(transactionToken),
        `${JSON.stringify(fractionalRevision, null, 2)}\n`,
      );
      await expect(store.read(transactionToken)).rejects.toBeInstanceOf(
        RemoteTransactionRecordIntegrityError,
      );
      await fs.writeFile(store.recordPath(transactionToken), originalBytes, { mode: 0o600 });
      await expect(store.read(transactionToken)).resolves.toMatchObject({ transactionToken });

      const unauthenticatedRevision = {
        ...originalEnvelope,
        revision: originalEnvelope.revision + 1,
      };
      await fs.writeFile(
        store.recordPath(transactionToken),
        `${JSON.stringify(unauthenticatedRevision, null, 2)}\n`,
      );
      await expect(store.read(transactionToken)).rejects.toBeInstanceOf(
        RemoteTransactionRecordIntegrityError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects copied cleanup authority, filename swaps, and modified payload bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-integrity-forgery-"));
    const directory = path.join(root, "transactions");
    const integrityKeyPath = path.join(root, "protected", "record-integrity.key");
    const victimToken = "5".repeat(64);
    const attackerToken = "6".repeat(64);
    const swappedToken = "7".repeat(64);
    const baseProcessIdentity = processIdentity(
      path.join(root, "victim-profile"),
      4567,
      "10000000-0000-4000-8000-000000000005",
    );
    const victimProcessIdentity = {
      ...baseProcessIdentity,
      launchClaim: { ...baseProcessIdentity.launchClaim, generationId: "store-generation" },
    };
    const victimRuntime: BrowserRuntimeMetadata = {
      ...runtime,
      chromePid: victimProcessIdentity.pid,
      chromeProcessIdentity: victimProcessIdentity,
      chromeProfileRoot: path.join(root, "victim-profile"),
      userDataDir: path.join(root, "victim-profile"),
      recoveryCleanupResources: runtime.recoveryCleanupResources.map((resource) => ({
        ...resource,
        chromePid: victimProcessIdentity.pid,
        chromeProcessIdentity: victimProcessIdentity,
        profileDirectoryIdentity: victimProcessIdentity.profileDirectory,
        chromeProfileRoot: path.join(root, "victim-profile"),
        userDataDir: path.join(root, "victim-profile"),
        acquisition: {
          generationId: victimProcessIdentity.launchClaim.generationId,
          processLaunchClaim: victimProcessIdentity.launchClaim,
        },
      })),
    };
    try {
      const store = await RemoteTransactionStore.open({ directory, integrityKeyPath });
      await begin(store, victimToken, "victim-run");
      await store.journalRuntime(victimToken, victimRuntime);
      await begin(store, attackerToken, "attacker-run");

      const victimRaw = await readFile(store.recordPath(victimToken), "utf8");
      const attackerEnvelope = JSON.parse(
        await readFile(store.recordPath(attackerToken), "utf8"),
      ) as { payload: string } & Record<string, unknown>;
      const victimEnvelope = JSON.parse(victimRaw) as {
        payload: string;
      } & Record<string, unknown>;

      await fs.writeFile(
        store.recordPath(attackerToken),
        `${JSON.stringify({ ...attackerEnvelope, payload: victimEnvelope.payload }, null, 2)}\n`,
      );
      await expect(store.read(attackerToken)).rejects.toBeInstanceOf(
        RemoteTransactionRecordIntegrityError,
      );

      await fs.writeFile(store.recordPath(swappedToken), victimRaw, { mode: 0o600 });
      await expect(store.read(swappedToken)).rejects.toBeInstanceOf(
        RemoteTransactionRecordIntegrityError,
      );

      const modifiedPayload = JSON.parse(
        Buffer.from(victimEnvelope.payload, "base64").toString("utf8"),
      ) as { runtime: { chromeTargetId?: string } };
      modifiedPayload.runtime.chromeTargetId = "forged-target";
      await fs.writeFile(
        store.recordPath(victimToken),
        `${JSON.stringify(
          {
            ...victimEnvelope,
            payload: Buffer.from(`${JSON.stringify(modifiedPayload, null, 2)}\n`).toString(
              "base64",
            ),
          },
          null,
          2,
        )}\n`,
      );
      await expect(store.read(victimToken)).rejects.toBeInstanceOf(
        RemoteTransactionRecordIntegrityError,
      );

      const quarantined = (await fs.readdir(directory)).filter((name) =>
        name.endsWith(".quarantine"),
      );
      expect(quarantined).toHaveLength(3);
      expect(quarantined).toEqual(
        expect.arrayContaining([
          expect.stringContaining(attackerToken),
          expect.stringContaining(swappedToken),
          expect.stringContaining(victimToken),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves a canonical replacement raced before atomic quarantine rename", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-quarantine-race-"));
    const directory = path.join(root, "transactions");
    const integrityKeyPath = path.join(root, "protected", "record-integrity.key");
    const transactionToken = "d".repeat(64);
    const corruptBytes = Buffer.from("corrupt authenticated generation\n", "utf8");
    let replacementBytes: Buffer | undefined;
    let recordPath: string | undefined;
    const beforeQuarantineUnlink = vi.fn(async () => {
      if (!recordPath || !replacementBytes) throw new Error("quarantine race was not prepared");
      await fs.unlink(recordPath);
      await fs.writeFile(recordPath, replacementBytes, { mode: 0o600 });
    });
    try {
      const store = await RemoteTransactionStore.open({
        directory,
        integrityKeyPath,
        beforeQuarantineUnlink,
      });
      await begin(store, transactionToken, "quarantine-race-run");
      recordPath = store.recordPath(transactionToken);
      replacementBytes = await fs.readFile(recordPath);
      await fs.writeFile(recordPath, corruptBytes);

      await expect(store.read(transactionToken)).rejects.toBeInstanceOf(
        RemoteTransactionRecordIntegrityError,
      );

      expect(beforeQuarantineUnlink).toHaveBeenCalledOnce();
      await expect(fs.readFile(recordPath)).resolves.toEqual(replacementBytes);
      const quarantined = (await fs.readdir(directory)).filter(
        (name) => name.includes(transactionToken) && name.endsWith(".quarantine"),
      );
      expect(quarantined).toHaveLength(1);
      const [quarantineName] = quarantined;
      if (!quarantineName) throw new Error("missing raced record quarantine");
      await expect(fs.readFile(path.join(directory, quarantineName))).resolves.toEqual(
        corruptBytes,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("quarantines oversized encoded and decoded records with exact bytes intact", async () => {
    const encodedRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-encoded-bound-"));
    const encodedToken = "1".repeat(64);
    const encodedBytes = Buffer.alloc(65, 0x78);
    try {
      const store = await openTransactionStore({
        directory: encodedRoot,
        maximumBytes: 64,
      });
      await fs.writeFile(store.recordPath(encodedToken), encodedBytes, { mode: 0o600 });

      await expect(store.read(encodedToken)).rejects.toBeInstanceOf(
        RemoteTransactionRecordIntegrityError,
      );
      await expect(fs.access(store.recordPath(encodedToken))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const encodedQuarantine = (await fs.readdir(encodedRoot)).find(
        (name) => name.includes(encodedToken) && name.endsWith(".quarantine"),
      );
      if (!encodedQuarantine) throw new Error("missing oversized encoded quarantine");
      await expect(fs.readFile(path.join(encodedRoot, encodedQuarantine))).resolves.toEqual(
        encodedBytes,
      );
    } finally {
      await rm(encodedRoot, { recursive: true, force: true });
    }

    const decodedRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-decoded-bound-"));
    const decodedToken = "2".repeat(64);
    try {
      const store = await openTransactionStore({
        directory: decodedRoot,
        maximumDecodedRecordBytes: 64,
      });
      await begin(store, decodedToken, "oversized-decoded-run");
      const recordPath = store.recordPath(decodedToken);
      const envelope = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
        payload: string;
      } & Record<string, unknown>;
      const oversizedEnvelope = Buffer.from(
        `${JSON.stringify(
          { ...envelope, payload: Buffer.alloc(65, 0x79).toString("base64") },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await fs.writeFile(recordPath, oversizedEnvelope);

      await expect(store.read(decodedToken)).rejects.toBeInstanceOf(
        RemoteTransactionRecordIntegrityError,
      );
      const decodedQuarantine = (await fs.readdir(decodedRoot)).find(
        (name) => name.includes(decodedToken) && name.endsWith(".quarantine"),
      );
      if (!decodedQuarantine) throw new Error("missing oversized decoded quarantine");
      await expect(fs.readFile(path.join(decodedRoot, decodedQuarantine))).resolves.toEqual(
        oversizedEnvelope,
      );
    } finally {
      await rm(decodedRoot, { recursive: true, force: true });
    }
  });

  test("enforces deterministic quarantine count and byte retention", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-quarantine-retention-"));
    const tokens = ["3".repeat(64), "4".repeat(64), "5".repeat(64), "6".repeat(64)];
    try {
      const store = await openTransactionStore({
        directory: root,
        maximumQuarantineRecords: 2,
        maximumQuarantineBytes: 7,
      });
      const quarantine = async (token: string, contents: Buffer): Promise<string> => {
        await fs.writeFile(store.recordPath(token), contents, { mode: 0o600 });
        await expect(store.read(token)).rejects.toBeInstanceOf(
          RemoteTransactionRecordIntegrityError,
        );
        const name = (await fs.readdir(root)).find(
          (candidate) => candidate.includes(token) && candidate.endsWith(".quarantine"),
        );
        if (!name) throw new Error(`missing quarantine for ${token}`);
        await expect(fs.readFile(path.join(root, name))).resolves.toEqual(contents);
        return name;
      };

      const first = await quarantine(tokens[0]!, Buffer.alloc(3, 0x61));
      await fs.utimes(path.join(root, first), new Date(1_000), new Date(1_000));
      const second = await quarantine(tokens[1]!, Buffer.alloc(3, 0x62));
      await fs.utimes(path.join(root, second), new Date(2_000), new Date(2_000));
      const third = await quarantine(tokens[2]!, Buffer.alloc(1, 0x63));
      await fs.utimes(path.join(root, third), new Date(3_000), new Date(3_000));

      let retained = (await fs.readdir(root)).filter((name) => name.endsWith(".quarantine"));
      expect(retained).toEqual(expect.arrayContaining([second, third]));
      expect(retained).toHaveLength(2);
      expect(
        (await Promise.all(retained.map((name) => fs.stat(path.join(root, name))))).reduce(
          (total, entry) => total + entry.size,
          0,
        ),
      ).toBe(4);

      const fourth = await quarantine(tokens[3]!, Buffer.alloc(7, 0x64));
      retained = (await fs.readdir(root)).filter((name) => name.endsWith(".quarantine"));
      expect(retained).toEqual([fourth]);
      await expect(fs.readFile(path.join(root, fourth))).resolves.toEqual(Buffer.alloc(7, 0x64));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("quarantines unsigned legacy and wrong-key records without cleanup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-integrity-quarantine-"));
    const directory = path.join(root, "transactions");
    const integrityKeyPath = path.join(root, "protected", "record-integrity.key");
    const wrongKeyPath = path.join(root, "other-protected", "record-integrity.key");
    const unsignedToken = "8".repeat(64);
    const wrongKeyToken = "9".repeat(64);
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    try {
      const store = await RemoteTransactionStore.open({
        directory,
        integrityKeyPath,
        terminalRetentionMs: 1,
        now: () => now,
      });
      await begin(store, unsignedToken, "unsigned-run");
      await store.beginArtifactNamespaceInitialization({
        transactionToken: unsignedToken,
        runId: "unsigned-run",
      });
      await store.bindArtifactNamespaceIdentity({
        transactionToken: unsignedToken,
        runId: "unsigned-run",
        identity: { device: "1", inode: "2", birthtimeNs: "3" },
      });
      await store.completeArtifactNamespaceInitialization({
        transactionToken: unsignedToken,
        runId: "unsigned-run",
      });
      await store.recordRecoverableFailure({
        transactionToken: unsignedToken,
        error: failure(false),
      });
      const signedEnvelope = JSON.parse(
        await readFile(store.recordPath(unsignedToken), "utf8"),
      ) as { payload: string };
      const unsignedBytes = Buffer.from(signedEnvelope.payload, "base64");
      await fs.writeFile(store.recordPath(unsignedToken), unsignedBytes);
      const cleanup = vi.fn(async () => true);
      store.registerArtifactNamespaceCleanup(cleanup);
      now += 2;
      await expect(store.list()).resolves.toEqual([]);
      expect(cleanup).not.toHaveBeenCalled();
      const unsignedQuarantine = (await fs.readdir(directory)).find(
        (name) => name.includes(unsignedToken) && name.endsWith(".quarantine"),
      );
      if (!unsignedQuarantine) throw new Error("missing unsigned record quarantine");
      await expect(fs.readFile(path.join(directory, unsignedQuarantine))).resolves.toEqual(
        unsignedBytes,
      );

      const originalStore = await RemoteTransactionStore.open({ directory, integrityKeyPath });
      await begin(originalStore, wrongKeyToken, "wrong-key-run");
      await originalStore.journalRuntime(wrongKeyToken, runtime);
      const wrongKeyBytes = await fs.readFile(originalStore.recordPath(wrongKeyToken));
      await fs.mkdir(path.dirname(wrongKeyPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(wrongKeyPath, Buffer.alloc(32, 0x5a), { mode: 0o600 });
      const wrongKeyStore = await RemoteTransactionStore.open({
        directory,
        integrityKeyPath: wrongKeyPath,
      });
      await expect(wrongKeyStore.list()).resolves.toEqual([]);
      const wrongKeyQuarantine = (await fs.readdir(directory)).find(
        (name) => name.includes(wrongKeyToken) && name.endsWith(".quarantine"),
      );
      if (!wrongKeyQuarantine) throw new Error("missing wrong-key record quarantine");
      await expect(fs.readFile(path.join(directory, wrongKeyQuarantine))).resolves.toEqual(
        wrongKeyBytes,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "rejects an integrity key whose mode is no longer 0600",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-integrity-key-mode-"));
      const directory = path.join(root, "transactions");
      const integrityKeyPath = path.join(root, "protected", "record-integrity.key");
      const transactionToken = "c".repeat(64);
      try {
        const store = await RemoteTransactionStore.open({ directory, integrityKeyPath });
        await begin(store, transactionToken);
        const signedRecord = await readFile(store.recordPath(transactionToken));
        await fs.chmod(integrityKeyPath, 0o640);

        await expect(RemoteTransactionStore.open({ directory, integrityKeyPath })).rejects.toThrow(
          "Remote transaction integrity key permissions must be 0600",
        );
        await expect(fs.readFile(store.recordPath(transactionToken))).resolves.toEqual(
          signedRecord,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("does not replace a missing integrity key while authenticated records remain", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-integrity-missing-key-"));
    const directory = path.join(root, "transactions");
    const integrityKeyPath = path.join(root, "protected", "record-integrity.key");
    const transactionToken = "b".repeat(64);
    try {
      const store = await RemoteTransactionStore.open({ directory, integrityKeyPath });
      await begin(store, transactionToken);
      const signedRecord = await readFile(store.recordPath(transactionToken));
      await fs.rm(integrityKeyPath);

      await expect(RemoteTransactionStore.open({ directory, integrityKeyPath })).rejects.toThrow(
        "Remote transaction integrity key is missing",
      );
      await expect(fs.readFile(store.recordPath(transactionToken))).resolves.toEqual(signedRecord);
      await expect(fs.stat(integrityKeyPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a swapped store-root generation before reading signed authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-integrity-root-swap-"));
    const directory = path.join(root, "transactions");
    const displacedDirectory = path.join(root, "transactions-displaced");
    const integrityKeyPath = path.join(root, "protected", "record-integrity.key");
    const transactionToken = "a".repeat(64);
    try {
      const store = await RemoteTransactionStore.open({ directory, integrityKeyPath });
      await begin(store, transactionToken);
      const signedRecord = await readFile(store.recordPath(transactionToken));
      await fs.rename(directory, displacedDirectory);
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.writeFile(path.join(directory, `${transactionToken}.json`), signedRecord, {
        mode: 0o600,
      });

      await expect(store.read(transactionToken)).rejects.toThrow(
        "Remote transaction store root generation changed",
      );
      await expect(fs.readFile(path.join(directory, `${transactionToken}.json`))).resolves.toEqual(
        signedRecord,
      );
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
      const store = await openTransactionStore({
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
      await store.beginSettlementExecution({ transactionToken: runtimeToken, mode: "abort" });
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
      const store = await openTransactionStore({
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
      const store = await openTransactionStore({ directory: byteRoot, maximumBytes: 64 });
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
      const store = await IsolatedRemoteTransactionStore.open({
        directory: atomicRoot,
        integrityKeyPath: path.join(atomicRoot, ".test-integrity", "record.key"),
      });
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
      expect(await fs.readdir(atomicRoot)).toEqual([".test-integrity"]);

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

  test("advances the controller-lifetime head only after a durable mutation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-head-advance-"));
    const transactionToken = "1".repeat(64);
    const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    const rename = vi.fn(actualFs.rename);
    rename.mockRejectedValueOnce(
      Object.assign(new Error("mutation publication interrupted"), { code: "EINTR" }),
    );
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actualFs, rename }));
    // Reload the mocked built-in export; a static import cannot observe this isolated fs failure seam.
    const { RemoteTransactionStore: IsolatedRemoteTransactionStore } =
      await import("../../src/remote/transactionStore.js");
    try {
      const store = await IsolatedRemoteTransactionStore.open({
        directory: root,
        integrityKeyPath: path.join(root, ".test-integrity", "record.key"),
      });
      await store.begin({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        transactionToken,
        runId: "run-1",
        createdAt: new Date().toISOString(),
        ...authority,
      });
      const afterBegin = JSON.parse(
        await readFile(store.recordPath(transactionToken), "utf8"),
      ) as TestTransactionEnvelope;
      expect(afterBegin.revision).toBe(1);

      await expect(store.journalRuntime(transactionToken, runtime)).rejects.toMatchObject({
        code: "EINTR",
      });
      const afterFailedMutation = JSON.parse(
        await readFile(store.recordPath(transactionToken), "utf8"),
      ) as TestTransactionEnvelope;
      expect(afterFailedMutation.revision).toBe(afterBegin.revision);
      await expect(store.read(transactionToken)).resolves.not.toHaveProperty("runtime");

      await store.journalRuntime(transactionToken, runtime);
      const afterRetry = JSON.parse(
        await readFile(store.recordPath(transactionToken), "utf8"),
      ) as TestTransactionEnvelope;
      expect(afterRetry.revision).toBe(afterBegin.revision + 1);
      await expect(store.read(transactionToken)).resolves.toMatchObject({ runtime });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("redacts terminal authority and prunes it after retention", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-terminal-store-"));
    const transactionToken = "f".repeat(64);
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    try {
      const store = await openTransactionStore({
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
      await store.beginSettlementExecution({ transactionToken, mode: "abort" });
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
      const reopened = await openTransactionStore({
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
