import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { RemoteArtifactStore } from "../../src/remote/artifactStore.js";
import {
  missingRequiredArtifactDeliveries,
  RemoteTransactionStore,
} from "../../src/remote/transactionStore.js";
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
}

describe("RemoteArtifactStore", () => {
  test("keeps artifacts authorized across restart until durable transaction settlement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-store-"));
    const sessionsRoot = path.join(root, "sessions");
    const artifactDirectory = path.join(sessionsRoot, "session-1", "artifacts");
    const artifactPath = path.join(artifactDirectory, "result.txt");
    const transactionDirectory = path.join(root, "transactions");
    const transactionToken = "c".repeat(64);
    const payload = Buffer.from("durable artifact", "utf8");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    let now = Date.parse("2026-01-01T00:00:00.000Z");

    try {
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(artifactPath, payload);
      const firstTransactionStore = await RemoteTransactionStore.open({
        directory: transactionDirectory,
        controllerGeneration: "controller-generation-1",
        now: () => now,
      });
      await begin(firstTransactionStore, transactionToken, "run-1");
      const firstArtifactStore = new RemoteArtifactStore({
        transactionStore: firstTransactionStore,
        sessionsRoot,
        now: () => now,
      });
      const registrations = await firstArtifactStore.prepareRequiredArtifacts({
        transactionToken,
        runId: "run-1",
        artifacts: [
          {
            kind: "file",
            path: artifactPath,
            mimeType: "text/plain",
            sourceUrl: "browser-download",
          },
        ],
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
      expect(registration).toMatchObject({
        transactionToken,
        canonicalPath: await realpath(artifactPath),
        descriptor: {
          runId: "run-1",
          byteSize: payload.length,
          sha256,
          required: true,
        },
        fileIdentity: {
          device: expect.any(String),
          inode: expect.any(String),
          birthtimeNs: expect.any(String),
          ctimeNs: expect.any(String),
        },
      });
      expect(registration).not.toHaveProperty("expiresAt");
      const firstRecord = await firstTransactionStore.read(transactionToken);
      expect(firstRecord).not.toBeNull();
      expect(missingRequiredArtifactDeliveries(firstRecord!)).toHaveLength(1);

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
      try {
        await expect(opened.handle.readFile("utf8")).resolves.toBe(payload.toString("utf8"));
      } finally {
        await opened.handle.close();
      }

      const receiptParams = {
        transactionToken,
        artifactId: registration.descriptor.artifactId,
        byteSize: payload.length,
        sha256,
      };
      const firstReceipt = await restartedArtifactStore.recordDeliveryReceipt(receiptParams);
      const duplicateReceipt = await restartedArtifactStore.recordDeliveryReceipt(receiptParams);
      expect(duplicateReceipt).toEqual(firstReceipt);
      const deliveredRecord = await restartedTransactionStore.read(transactionToken);
      expect(deliveredRecord).not.toBeNull();
      expect(missingRequiredArtifactDeliveries(deliveredRecord!)).toHaveLength(0);
      await restartedTransactionStore.bindSettlement({
        transactionToken,
        mode: "abort",
        durablePublication: false,
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

  test("rejects a path generation that changed after durable registration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-identity-"));
    const sessionsRoot = path.join(root, "sessions");
    const artifactDirectory = path.join(sessionsRoot, "session-2", "artifacts");
    const artifactPath = path.join(artifactDirectory, "result.txt");
    const transactionToken = "d".repeat(64);
    try {
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(artifactPath, "first generation", "utf8");
      const transactionStore = await RemoteTransactionStore.open({
        directory: path.join(root, "transactions"),
        controllerGeneration: "controller-generation-1",
      });
      await begin(transactionStore, transactionToken, "run-2");
      const artifactStore = new RemoteArtifactStore({ transactionStore, sessionsRoot });
      const registrations = await artifactStore.prepareRequiredArtifacts({
        transactionToken,
        runId: "run-2",
        artifacts: [{ kind: "file", path: artifactPath, mimeType: "text/plain" }],
      });
      await transactionStore.publishCapture({
        transactionToken,
        runId: "run-2",
        result: capturedResult,
        runtime,
        artifacts: registrations,
      });
      const [registration] = registrations;
      if (!registration) throw new Error("Expected a durable artifact registration");

      await rm(artifactPath);
      await writeFile(artifactPath, "second generation", "utf8");
      await expect(
        artifactStore.openForDelivery(transactionToken, registration.descriptor.artifactId),
      ).rejects.toMatchObject({ code: "artifact_identity_changed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
