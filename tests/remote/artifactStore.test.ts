import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { SessionArtifact } from "../../src/sessionManager.js";
import { RemoteArtifactStore } from "../../src/remote/artifactStore.js";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import { missingRequiredArtifactDeliveries } from "../../src/remote/transactionValidation.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";

const authority = {
  requestIdentity: {
    acceptedPromptSha256: ["8".repeat(64)],
    followUpOrdinal: 0,
    remainingFollowUps: 0 as const,
  },
  browserConfig: { chatgptUrl: "https://chatgpt.com/" },
};

const runtime = {
  chromeTargetId: "target-1",
  conversationId: "conversation-1",
  promptEpoch: {
    status: "committed" as const,
    epochId: "epoch-1",
    promptSha256: "8".repeat(64),
    baselineTurns: 0,
    followUpOrdinal: 0,
    remainingFollowUps: 0,
    verifiedUserTurnIndex: 0,
    verifiedUserTurnId: "turn-1",
    verifiedUserMessageId: "message-1",
    conversationId: "conversation-1",
  },
};

const capturedResult = {
  answerText: "durable answer",
  answerMarkdown: "durable answer",
  tookMs: 1,
  answerTokens: 2,
  answerChars: 14,
};

async function begin(store: RemoteTransactionStore, transactionToken: string, runId: string) {
  await store.begin({
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    transactionToken,
    runId,
    createdAt: new Date().toISOString(),
    ...authority,
  });
  const record = await store.read(transactionToken);
  if (!record) throw new Error("Expected durable transaction record");
  return record;
}

async function writeArtifact(filePath: string, payload: Buffer): Promise<SessionArtifact> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, payload);
  const handle = await open(filePath, "r");
  try {
    const fileStat = await handle.stat({ bigint: true });
    return {
      kind: "file",
      path: filePath,
      mimeType: "text/plain",
      sizeBytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
      fileIdentity: {
        device: fileStat.dev.toString(),
        inode: fileStat.ino.toString(),
        birthtimeNs: fileStat.birthtimeNs.toString(),
        ctimeNs: fileStat.ctimeNs.toString(),
      },
      validation: { type: "generic", ok: true },
      sourceUrl: "browser-download",
    };
  } finally {
    await handle.close();
  }
}

describe("RemoteArtifactStore", () => {
  test("keeps exact transaction artifacts retrievable across restart until settlement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-store-"));
    const sessionsRoot = path.join(root, "sessions");
    const transactionDirectory = path.join(root, "transactions");
    const transactionToken = "c".repeat(64);
    const payload = Buffer.from("durable artifact", "utf8");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    let now = Date.parse("2026-01-01T00:00:00.000Z");

    try {
      const firstTransactionStore = await RemoteTransactionStore.open({
        directory: transactionDirectory,
        controllerGeneration: "controller-generation-1",
        now: () => now,
      });
      const record = await begin(firstTransactionStore, transactionToken, "run-1");
      const firstArtifactStore = new RemoteArtifactStore({
        transactionStore: firstTransactionStore,
        sessionsRoot,
        now: () => now,
      });
      const writeAuthority = await firstArtifactStore.createArtifactWriteAuthority({
        transactionToken,
        runId: "run-1",
      });
      const artifactPath = path.join(writeAuthority.artifactsDirectory, "result.txt");
      const artifact = await writeArtifact(artifactPath, payload);
      const registrations = await firstArtifactStore.prepareRequiredArtifacts({
        transactionToken,
        runId: "run-1",
        artifacts: [artifact],
      });
      await firstTransactionStore.publishCapture({
        transactionToken,
        runId: "run-1",
        result: capturedResult,
        runtime,
        artifacts: registrations,
      });
      const [registration] = registrations;
      if (!registration) throw new Error("Expected a durable artifact registration");
      expect(record.artifactNamespace).toMatch(/^remote-[a-f0-9]{64}$/);
      expect(writeAuthority.artifactsDirectory).toBe(
        await realpath(path.join(sessionsRoot, record.artifactNamespace, "artifacts")),
      );
      expect(registration).toMatchObject({
        transactionToken,
        canonicalPath: await realpath(artifactPath),
        descriptor: {
          runId: "run-1",
          byteSize: payload.length,
          sha256,
          required: true,
        },
        fileIdentity: artifact.fileIdentity,
      });
      expect(
        missingRequiredArtifactDeliveries((await firstTransactionStore.read(transactionToken))!),
      ).toHaveLength(1);

      now += 31 * 60 * 1000;
      const restartedTransactionStore = await RemoteTransactionStore.open({
        directory: transactionDirectory,
        controllerGeneration: "controller-generation-2",
        now: () => now,
      });
      const restartedArtifactStore = new RemoteArtifactStore({
        transactionStore: restartedTransactionStore,
        sessionsRoot,
        now: () => now,
      });
      const opened = await restartedArtifactStore.openForDelivery(
        transactionToken,
        registration.descriptor.artifactId,
      );
      if (!opened) throw new Error("Expected restart-safe artifact authorization");
      await opened.handle.close();

      const receiptParams = {
        transactionToken,
        artifactId: registration.descriptor.artifactId,
        byteSize: payload.length,
        sha256,
      };
      const firstReceipt = await restartedArtifactStore.recordDeliveryReceipt(receiptParams);
      await expect(restartedArtifactStore.recordDeliveryReceipt(receiptParams)).resolves.toEqual(
        firstReceipt,
      );
      expect(
        missingRequiredArtifactDeliveries(
          (await restartedTransactionStore.read(transactionToken))!,
        ),
      ).toHaveLength(0);
      await restartedTransactionStore.bindSettlement({
        transactionToken,
        mode: "abort",
        durablePublication: false,
      });
      await restartedTransactionStore.beginSettlementExecution({
        transactionToken,
        mode: "abort",
      });
      await restartedTransactionStore.completeSettlement({
        transactionToken,
        mode: "abort",
        finalization: { status: "completed", runtime },
      });
      await expect(
        restartedArtifactStore.openForDelivery(
          transactionToken,
          registration.descriptor.artifactId,
        ),
      ).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects registration from another transaction namespace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-foreign-"));
    try {
      const sessionsRoot = path.join(root, "sessions");
      const store = await RemoteTransactionStore.open({
        directory: path.join(root, "transactions"),
      });
      const firstToken = "a".repeat(64);
      const secondToken = "b".repeat(64);
      await begin(store, firstToken, "run-a");
      await begin(store, secondToken, "run-b");
      const artifacts = new RemoteArtifactStore({ transactionStore: store, sessionsRoot });
      const foreignAuthority = await artifacts.createArtifactWriteAuthority({
        transactionToken: secondToken,
        runId: "run-b",
      });
      const foreignArtifact = await writeArtifact(
        path.join(foreignAuthority.artifactsDirectory, "result.txt"),
        Buffer.from("foreign bytes"),
      );

      await expect(
        artifacts.prepareRequiredArtifacts({
          transactionToken: firstToken,
          runId: "run-a",
          artifacts: [foreignArtifact],
        }),
      ).rejects.toThrow("outside its exact transaction artifact namespace");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "size",
      alter: (artifact: SessionArtifact) => ({ ...artifact, sizeBytes: artifact.sizeBytes! + 1 }),
      message: "physical identity does not match producer evidence",
    },
    {
      name: "sha256",
      alter: (artifact: SessionArtifact) => ({ ...artifact, sha256: "0".repeat(64) }),
      message: "sha256 does not match producer evidence",
    },
    {
      name: "file identity",
      alter: (artifact: SessionArtifact) => ({
        ...artifact,
        fileIdentity: { ...artifact.fileIdentity!, inode: `${artifact.fileIdentity!.inode}0` },
      }),
      message: "physical identity does not match producer evidence",
    },
  ])("rejects altered producer $name evidence", async ({ alter, message }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-evidence-"));
    try {
      const sessionsRoot = path.join(root, "sessions");
      const store = await RemoteTransactionStore.open({
        directory: path.join(root, "transactions"),
      });
      const transactionToken = "d".repeat(64);
      await begin(store, transactionToken, "run-evidence");
      const artifacts = new RemoteArtifactStore({ transactionStore: store, sessionsRoot });
      const writeAuthority = await artifacts.createArtifactWriteAuthority({
        transactionToken,
        runId: "run-evidence",
      });
      const artifact = await writeArtifact(
        path.join(writeAuthority.artifactsDirectory, "result.txt"),
        Buffer.from("producer bytes"),
      );

      await expect(
        artifacts.prepareRequiredArtifacts({
          transactionToken,
          runId: "run-evidence",
          artifacts: [alter(artifact)],
        }),
      ).rejects.toThrow(message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a replacement made after producer evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-producer-race-"));
    try {
      const sessionsRoot = path.join(root, "sessions");
      const store = await RemoteTransactionStore.open({
        directory: path.join(root, "transactions"),
      });
      const transactionToken = "e".repeat(64);
      await begin(store, transactionToken, "run-producer-race");
      const artifacts = new RemoteArtifactStore({ transactionStore: store, sessionsRoot });
      const writeAuthority = await artifacts.createArtifactWriteAuthority({
        transactionToken,
        runId: "run-producer-race",
      });
      const artifactPath = path.join(writeAuthority.artifactsDirectory, "result.txt");
      const artifact = await writeArtifact(artifactPath, Buffer.from("same-length-a"));
      await rm(artifactPath);
      await writeFile(artifactPath, "same-length-b");

      await expect(
        artifacts.prepareRequiredArtifacts({
          transactionToken,
          runId: "run-producer-race",
          artifacts: [artifact],
        }),
      ).rejects.toThrow("physical identity does not match producer evidence");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a replacement made after durable registration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-delivery-race-"));
    try {
      const sessionsRoot = path.join(root, "sessions");
      const store = await RemoteTransactionStore.open({
        directory: path.join(root, "transactions"),
      });
      const transactionToken = "f".repeat(64);
      await begin(store, transactionToken, "run-delivery-race");
      const artifacts = new RemoteArtifactStore({ transactionStore: store, sessionsRoot });
      const writeAuthority = await artifacts.createArtifactWriteAuthority({
        transactionToken,
        runId: "run-delivery-race",
      });
      const artifactPath = path.join(writeAuthority.artifactsDirectory, "result.txt");
      const artifact = await writeArtifact(artifactPath, Buffer.from("first generation"));
      const registrations = await artifacts.prepareRequiredArtifacts({
        transactionToken,
        runId: "run-delivery-race",
        artifacts: [artifact],
      });
      await store.publishCapture({
        transactionToken,
        runId: "run-delivery-race",
        result: capturedResult,
        runtime,
        artifacts: registrations,
      });
      const [registration] = registrations;
      if (!registration) throw new Error("Expected a durable artifact registration");
      await rm(artifactPath);
      await writeFile(artifactPath, "second generation");

      await expect(
        artifacts.openForDelivery(transactionToken, registration.descriptor.artifactId),
      ).rejects.toMatchObject({ code: "artifact_identity_changed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked transaction namespace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-namespace-alias-"));
    try {
      const sessionsRoot = path.join(root, "sessions");
      const store = await RemoteTransactionStore.open({
        directory: path.join(root, "transactions"),
      });
      const transactionToken = "1".repeat(64);
      const record = await begin(store, transactionToken, "run-alias");
      const foreignDirectory = path.join(root, "foreign");
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(foreignDirectory, { recursive: true });
      await symlink(foreignDirectory, path.join(sessionsRoot, record.artifactNamespace), "dir");
      const artifacts = new RemoteArtifactStore({ transactionStore: store, sessionsRoot });

      await expect(
        artifacts.createArtifactWriteAuthority({ transactionToken, runId: "run-alias" }),
      ).rejects.toThrow("not created exclusively");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
