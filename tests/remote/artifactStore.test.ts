import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  access,
  mkdir,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import type { SessionArtifact } from "../../src/sessionManager.js";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import { missingRequiredArtifactDeliveries } from "../../src/remote/transactionValidation.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";
import {
  createTestRemoteArtifactStore,
  openTestRemoteTransactionStore,
} from "./testTransactionStore.js";
import {
  establishWindowsPrivateDirectories,
  initializeWindowsPrivateFile,
  protectWindowsPrivateFile,
  verifyWindowsPrivateFile,
} from "../../src/windowsPrivateFileAcl.js";
import {
  testWindowsPrivateDirectoriesAuthority,
  testWindowsPrivateFileProtectionAuthority,
  testWindowsPrivateFileVerificationAuthority,
} from "../privateAuthorityTestHelpers.js";

function openTransactionStore(
  options: Omit<Parameters<typeof RemoteTransactionStore.open>[0], "integrityKeyPath">,
) {
  return openTestRemoteTransactionStore({
    ...options,
    integrityKeyPath: path.join(options.directory, ".test-integrity", "record.key"),
  });
}

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

async function writePrivateArtifactFixture(
  filePath: string,
  payload: Buffer | string,
): Promise<void> {
  const directory = path.dirname(filePath);
  if (process.platform !== "win32") {
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, payload);
    return;
  }
  await establishWindowsPrivateDirectories([directory]);
  if (!(await initializeWindowsPrivateFile(filePath))) {
    throw new Error("Expected a fresh Windows private artifact fixture");
  }
  const handle = await open(filePath, "r+");
  try {
    await handle.writeFile(payload);
  } finally {
    await handle.close();
  }
  await verifyWindowsPrivateFile(filePath);
}

async function writeArtifact(
  filePath: string,
  payload: Buffer,
  nativeWindowsAuthority = false,
): Promise<SessionArtifact> {
  if (nativeWindowsAuthority) await writePrivateArtifactFixture(filePath, payload);
  else {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, payload);
  }
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
      const firstTransactionStore = await openTransactionStore({
        directory: transactionDirectory,
        controllerGeneration: "controller-generation-1",
        now: () => now,
      });
      const record = await begin(firstTransactionStore, transactionToken, "run-1");
      const firstArtifactStore = createTestRemoteArtifactStore({
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
      const restartedTransactionStore = await openTransactionStore({
        directory: transactionDirectory,
        controllerGeneration: "controller-generation-2",
        now: () => now,
      });
      const restartedArtifactStore = createTestRemoteArtifactStore({
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
      const store = await openTransactionStore({
        directory: path.join(root, "transactions"),
      });
      const firstToken = "a".repeat(64);
      const secondToken = "b".repeat(64);
      await begin(store, firstToken, "run-a");
      await begin(store, secondToken, "run-b");
      const artifacts = createTestRemoteArtifactStore({ transactionStore: store, sessionsRoot });
      await artifacts.createArtifactWriteAuthority({
        transactionToken: firstToken,
        runId: "run-a",
      });
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

  test("rejects artifacts outside sessions root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-boundary-"));
    try {
      const sessionsRoot = path.join(root, "sessions");
      const store = await openTransactionStore({
        directory: path.join(root, "transactions"),
      });
      const transactionToken = "1".repeat(64);
      await begin(store, transactionToken, "run-boundary");
      const artifacts = createTestRemoteArtifactStore({ transactionStore: store, sessionsRoot });
      await artifacts.createArtifactWriteAuthority({ transactionToken, runId: "run-boundary" });
      const outsideArtifact = await writeArtifact(
        path.join(root, "outside.txt"),
        Buffer.from("outside"),
      );

      await expect(
        artifacts.prepareRequiredArtifacts({
          transactionToken,
          runId: "run-boundary",
          artifacts: [outsideArtifact],
        }),
      ).rejects.toThrow("outside its exact transaction artifact namespace");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects artifacts outside a session artifacts directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-boundary-"));
    try {
      const sessionsRoot = path.join(root, "sessions");
      const store = await openTransactionStore({
        directory: path.join(root, "transactions"),
      });
      const transactionToken = "2".repeat(64);
      await begin(store, transactionToken, "run-boundary");
      const artifacts = createTestRemoteArtifactStore({ transactionStore: store, sessionsRoot });
      const writeAuthority = await artifacts.createArtifactWriteAuthority({
        transactionToken,
        runId: "run-boundary",
      });
      const outsideArtifact = await writeArtifact(
        path.join(path.dirname(writeAuthority.artifactsDirectory), "outside.txt"),
        Buffer.from("outside"),
      );

      await expect(
        artifacts.prepareRequiredArtifacts({
          transactionToken,
          runId: "run-boundary",
          artifacts: [outsideArtifact],
        }),
      ).rejects.toThrow("outside its exact transaction artifact namespace");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects symlinked artifacts escaping sessions root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-boundary-"));
    try {
      const sessionsRoot = path.join(root, "sessions");
      const store = await openTransactionStore({
        directory: path.join(root, "transactions"),
      });
      const transactionToken = "3".repeat(64);
      await begin(store, transactionToken, "run-boundary");
      const artifacts = createTestRemoteArtifactStore({ transactionStore: store, sessionsRoot });
      const writeAuthority = await artifacts.createArtifactWriteAuthority({
        transactionToken,
        runId: "run-boundary",
      });
      const outsideArtifact = await writeArtifact(
        path.join(root, "outside.txt"),
        Buffer.from("outside"),
      );
      const symlinkPath = path.join(writeAuthority.artifactsDirectory, "escaped.txt");
      await symlink(outsideArtifact.path!, symlinkPath);

      await expect(
        artifacts.prepareRequiredArtifacts({
          transactionToken,
          runId: "run-boundary",
          artifacts: [{ ...outsideArtifact, path: symlinkPath }],
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
      const store = await openTransactionStore({
        directory: path.join(root, "transactions"),
      });
      const transactionToken = "d".repeat(64);
      await begin(store, transactionToken, "run-evidence");
      const artifacts = createTestRemoteArtifactStore({ transactionStore: store, sessionsRoot });
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

  describe.sequential("Windows-native artifact mutation authority cohort", () => {
    test("rejects a replacement made after producer evidence", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-producer-race-"));
      try {
        const sessionsRoot = path.join(root, "sessions");
        const store = await openTransactionStore({
          directory: path.join(root, "transactions"),
        });
        const transactionToken = "e".repeat(64);
        await begin(store, transactionToken, "run-producer-race");
        const artifacts = createTestRemoteArtifactStore({
          transactionStore: store,
          sessionsRoot,
          windowsPrivateDirectoriesAuthority: establishWindowsPrivateDirectories,
          windowsPrivateFileProtectionAuthority: protectWindowsPrivateFile,
          windowsPrivateFileVerificationAuthority: verifyWindowsPrivateFile,
        });
        const writeAuthority = await artifacts.createArtifactWriteAuthority({
          transactionToken,
          runId: "run-producer-race",
        });
        const artifactPath = path.join(writeAuthority.artifactsDirectory, "result.txt");
        const artifact = await writeArtifact(artifactPath, Buffer.from("same-length-a"), true);
        await rm(artifactPath);
        await writePrivateArtifactFixture(artifactPath, "same-length-a");

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
        const store = await openTransactionStore({
          directory: path.join(root, "transactions"),
        });
        const transactionToken = "f".repeat(64);
        await begin(store, transactionToken, "run-delivery-race");
        const artifacts = createTestRemoteArtifactStore({
          transactionStore: store,
          sessionsRoot,
          windowsPrivateDirectoriesAuthority: establishWindowsPrivateDirectories,
          windowsPrivateFileProtectionAuthority: protectWindowsPrivateFile,
          windowsPrivateFileVerificationAuthority: verifyWindowsPrivateFile,
        });
        const writeAuthority = await artifacts.createArtifactWriteAuthority({
          transactionToken,
          runId: "run-delivery-race",
        });
        const artifactPath = path.join(writeAuthority.artifactsDirectory, "result.txt");
        const artifact = await writeArtifact(artifactPath, Buffer.from("first generation"), true);
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
        await writePrivateArtifactFixture(artifactPath, "second generation");

        await expect(
          artifacts.openForDelivery(transactionToken, registration.descriptor.artifactId),
        ).rejects.toMatchObject({ code: "artifact_identity_changed" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  test("rolls back an empty fresh namespace when physical identity capture fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-capture-failure-"));
    const transactionToken = "5".repeat(64);
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const captureFailure = Object.assign(new Error("simulated namespace identity failure"), {
      code: "EIO",
    });
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const mockedLstat = vi.fn(async (...args: unknown[]) => {
      const [candidatePath] = args;
      if (path.basename(String(candidatePath)).startsWith("remote-")) throw captureFailure;
      return await Reflect.apply(actualFs.lstat, actualFs, args);
    });
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actualFs, lstat: mockedLstat }));
    const { RemoteArtifactStore: IsolatedRemoteArtifactStore } =
      await import("../../src/remote/artifactStore.js");
    try {
      const sessionsRoot = path.join(root, "sessions");
      const store = await openTransactionStore({
        directory: path.join(root, "transactions"),
        terminalRetentionMs: 1_000,
        now: () => now,
      });
      const begun = await begin(store, transactionToken, "run-capture-failure");
      const artifacts = new IsolatedRemoteArtifactStore({
        transactionStore: store,
        sessionsRoot,
        windowsPrivateDirectoriesAuthority: testWindowsPrivateDirectoriesAuthority,
        windowsPrivateFileProtectionAuthority: testWindowsPrivateFileProtectionAuthority,
        windowsPrivateFileVerificationAuthority: testWindowsPrivateFileVerificationAuthority,
      });

      await expect(
        artifacts.createArtifactWriteAuthority({
          transactionToken,
          runId: "run-capture-failure",
        }),
      ).rejects.toBe(captureFailure);
      const failed = await store.read(transactionToken);
      expect(failed).toMatchObject({
        state: "failed",
        artifactNamespaceState: "uninitialized",
        terminalAudit: {
          errorCode: "remote-artifact-namespace-initialization-failed",
          errorStage: "remote-artifact-namespace-initialization",
        },
      });
      expect(failed).not.toHaveProperty("artifactNamespaceIdentity");
      await expect(access(path.join(sessionsRoot, begun.artifactNamespace))).rejects.toMatchObject({
        code: "ENOENT",
      });

      now += 1_001;
      await expect(store.list()).resolves.toEqual([]);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed before persisting a zero-birthtime artifact namespace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-zero-birth-"));
    const transactionToken = "0".repeat(64);
    const actualFs = await vi.importActual<Record<string, unknown> & { lstat: typeof lstat }>(
      "node:fs/promises",
    );
    const mockedLstat = vi.fn(async (...args: unknown[]) => {
      const entry = await Reflect.apply(actualFs.lstat, actualFs, args);
      const [candidatePath] = args;
      if (!path.basename(String(candidatePath)).startsWith("remote-")) return entry;
      return new Proxy(entry, {
        get(target, property, receiver) {
          return property === "birthtimeNs" ? 0n : Reflect.get(target, property, receiver);
        },
      });
    });
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actualFs, lstat: mockedLstat }));
    // Test-isolated reload is required because the generic identity module captured lstat before vi.doMock.
    const { RemoteArtifactStore: IsolatedRemoteArtifactStore } =
      await import("../../src/remote/artifactStore.js");
    try {
      const sessionsRoot = path.join(root, "sessions");
      const store = await openTransactionStore({
        directory: path.join(root, "transactions"),
      });
      const begun = await begin(store, transactionToken, "run-zero-birth");
      const artifacts = new IsolatedRemoteArtifactStore({
        transactionStore: store,
        sessionsRoot,
        windowsPrivateDirectoriesAuthority: testWindowsPrivateDirectoriesAuthority,
        windowsPrivateFileProtectionAuthority: testWindowsPrivateFileProtectionAuthority,
        windowsPrivateFileVerificationAuthority: testWindowsPrivateFileVerificationAuthority,
      });

      await expect(
        artifacts.createArtifactWriteAuthority({
          transactionToken,
          runId: "run-zero-birth",
        }),
      ).rejects.toThrow(/ORACLE_HOME_DIR.*stable nonzero birth time/i);
      const failed = await store.read(transactionToken);
      expect(failed).toMatchObject({
        state: "failed",
        artifactNamespaceState: "uninitialized",
        terminalAudit: {
          errorCode: "remote-artifact-namespace-initialization-failed",
          errorStage: "remote-artifact-namespace-initialization",
        },
      });
      expect(failed).not.toHaveProperty("artifactNamespaceIdentity");
      await expect(access(path.join(sessionsRoot, begun.artifactNamespace))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rolls back exact authority when durable identity binding reports failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-bind-failure-"));
    const transactionToken = "6".repeat(64);
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const sessionsRoot = path.join(root, "sessions");
    const store = await openTransactionStore({
      directory: path.join(root, "transactions"),
      terminalRetentionMs: 1_000,
      now: () => now,
    });
    const durableBind = store.bindArtifactNamespaceIdentity.bind(store);
    const bindFailure = new Error("simulated durable namespace identity bind failure");
    const bindSpy = vi
      .spyOn(store, "bindArtifactNamespaceIdentity")
      .mockImplementationOnce(async (params) => {
        await durableBind(params);
        throw bindFailure;
      });
    try {
      const begun = await begin(store, transactionToken, "run-bind-failure");
      const artifacts = createTestRemoteArtifactStore({ transactionStore: store, sessionsRoot });

      await expect(
        artifacts.createArtifactWriteAuthority({
          transactionToken,
          runId: "run-bind-failure",
        }),
      ).rejects.toBe(bindFailure);
      const failed = await store.read(transactionToken);
      expect(failed).toMatchObject({
        state: "failed",
        artifactNamespaceState: "uninitialized",
        terminalAudit: {
          errorCode: "remote-artifact-namespace-initialization-failed",
          errorStage: "remote-artifact-namespace-initialization",
        },
      });
      expect(failed).not.toHaveProperty("artifactNamespaceIdentity");
      await expect(access(path.join(sessionsRoot, begun.artifactNamespace))).rejects.toMatchObject({
        code: "ENOENT",
      });

      now += 1_001;
      await expect(store.list()).resolves.toEqual([]);
    } finally {
      bindSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("settles namespace authority failure and removes only its exact fresh directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-init-failure-"));
    const transactionToken = "2".repeat(64);
    const mkdirFailure = Object.assign(new Error("simulated artifacts directory failure"), {
      code: "EIO",
    });
    const windowsPrivateDirectoriesAuthority = vi.fn(async (directoryPaths: readonly string[]) => {
      for (const directoryPath of directoryPaths) {
        await mkdir(directoryPath, { recursive: true });
      }
      if (directoryPaths.some((directoryPath) => path.basename(directoryPath) === "artifacts")) {
        throw mkdirFailure;
      }
    });
    try {
      const sessionsRoot = path.join(root, "sessions");
      const store = await openTransactionStore({
        directory: path.join(root, "transactions"),
      });
      const begun = await begin(store, transactionToken, "run-init-failure");
      const namespaceDirectory = path.join(sessionsRoot, begun.artifactNamespace);
      const artifactsDirectory = path.join(namespaceDirectory, "artifacts");
      const artifacts = createTestRemoteArtifactStore({
        transactionStore: store,
        sessionsRoot,
        platform: "win32",
        windowsPrivateDirectoriesAuthority,
      });

      await expect(
        artifacts.createArtifactWriteAuthority({
          transactionToken,
          runId: "run-init-failure",
        }),
      ).rejects.toBe(mkdirFailure);
      expect(windowsPrivateDirectoriesAuthority.mock.calls).toEqual([
        [[namespaceDirectory]],
        [[namespaceDirectory, artifactsDirectory]],
      ]);
      const failed = await store.read(transactionToken);
      expect(failed).toMatchObject({
        state: "failed",
        artifactNamespaceState: "uninitialized",
        terminalAudit: {
          errorCode: "remote-artifact-namespace-initialization-failed",
          errorStage: "remote-artifact-namespace-initialization",
        },
      });
      expect(failed).not.toHaveProperty("artifactNamespaceIdentity");
      await expect(access(namespaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("prunes a terminal record only after exact namespace cleanup and fails closed on substitution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-retention-"));
    const sessionsRoot = path.join(root, "sessions");
    const cleanedToken = "3".repeat(64);
    const substitutedToken = "4".repeat(64);
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    try {
      const store = await openTransactionStore({
        directory: path.join(root, "transactions"),
        terminalRetentionMs: 1_000,
        now: () => now,
      });
      const artifacts = createTestRemoteArtifactStore({ transactionStore: store, sessionsRoot });
      const cleaned = await begin(store, cleanedToken, "run-cleaned");
      await artifacts.createArtifactWriteAuthority({
        transactionToken: cleanedToken,
        runId: "run-cleaned",
      });
      await store.recordRecoverableFailure({
        transactionToken: cleanedToken,
        error: {
          name: "BrowserAutomationError",
          category: "browser-automation",
          message: "terminal fixture",
          recoverableDisconnect: false,
        },
      });

      const substituted = await begin(store, substitutedToken, "run-substituted");
      await artifacts.createArtifactWriteAuthority({
        transactionToken: substitutedToken,
        runId: "run-substituted",
      });
      await store.recordRecoverableFailure({
        transactionToken: substitutedToken,
        error: {
          name: "BrowserAutomationError",
          category: "browser-automation",
          message: "terminal fixture",
          recoverableDisconnect: false,
        },
      });
      const substitutedPath = path.join(sessionsRoot, substituted.artifactNamespace);
      await rm(substitutedPath, { recursive: true });
      await mkdir(substitutedPath);

      now += 1_001;
      await expect(store.list()).resolves.toEqual([
        expect.objectContaining({ transactionToken: substitutedToken, state: "failed" }),
      ]);
      await expect(store.read(cleanedToken)).resolves.toBeNull();
      await expect(
        access(path.join(sessionsRoot, cleaned.artifactNamespace)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(substitutedPath)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retains a replaced no-identity namespace across cold restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-cold-restart-"));
    const sessionsRoot = path.join(root, "sessions");
    const transactionDirectory = path.join(root, "transactions");
    const transactionToken = "7".repeat(64);
    const runId = "run-cold-restart";
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    try {
      const initial = await openTransactionStore({
        directory: transactionDirectory,
        controllerGeneration: "artifact-controller-before-restart",
        terminalRetentionMs: 1_000,
        now: () => now,
      });
      const begun = await begin(initial, transactionToken, runId);
      await initial.beginArtifactNamespaceInitialization({ transactionToken, runId });
      const namespacePath = path.join(sessionsRoot, begun.artifactNamespace);
      await mkdir(namespacePath, { recursive: true });
      await rm(namespacePath, { recursive: true });
      await mkdir(namespacePath);
      const foreignFile = path.join(namespacePath, "foreign.txt");
      await writeFile(foreignFile, "foreign generation");

      const restarted = await openTransactionStore({
        directory: transactionDirectory,
        controllerGeneration: "artifact-controller-after-restart",
        terminalRetentionMs: 1_000,
        now: () => now,
      });
      await expect(
        restarted.reconcileStaleRunningRecords({
          buildError: (_record, hadRuntimeAuthority) => ({
            name: "BrowserAutomationError",
            category: "browser-automation",
            message: "stale artifact namespace controller",
            recoverableDisconnect: hadRuntimeAuthority,
          }),
        }),
      ).resolves.toEqual([
        {
          transactionToken,
          previousControllerGeneration: "artifact-controller-before-restart",
          state: "failed",
          hadRuntimeAuthority: false,
        },
      ]);
      createTestRemoteArtifactStore({ transactionStore: restarted, sessionsRoot });

      now += 1_001;
      await expect(restarted.list()).resolves.toEqual([
        expect.objectContaining({
          transactionToken,
          state: "failed",
          artifactNamespaceState: "initializing",
          controllerGeneration: "artifact-controller-after-restart",
        }),
      ]);
      const retained = await restarted.read(transactionToken);
      expect(retained).not.toBeNull();
      expect(retained).not.toHaveProperty("artifactNamespaceIdentity");
      await expect(readFile(foreignFile, "utf8")).resolves.toBe("foreign generation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked transaction namespace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-namespace-alias-"));
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    try {
      const sessionsRoot = path.join(root, "sessions");
      const store = await openTransactionStore({
        directory: path.join(root, "transactions"),
        terminalRetentionMs: 1_000,
        now: () => now,
      });
      const transactionToken = "1".repeat(64);
      const record = await begin(store, transactionToken, "run-alias");
      const foreignDirectory = path.join(root, "foreign");
      const aliasPath = path.join(sessionsRoot, record.artifactNamespace);
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(foreignDirectory, { recursive: true });
      await symlink(foreignDirectory, aliasPath, "dir");
      const artifacts = createTestRemoteArtifactStore({ transactionStore: store, sessionsRoot });

      await expect(
        artifacts.createArtifactWriteAuthority({ transactionToken, runId: "run-alias" }),
      ).rejects.toThrow("not created exclusively");
      await expect(store.read(transactionToken)).resolves.toMatchObject({
        state: "failed",
        artifactNamespaceState: "initializing",
        terminalAudit: {
          errorCode: "remote-artifact-namespace-initialization-failed",
          errorStage: "remote-artifact-namespace-initialization",
        },
      });
      const canonicalForeignDirectory = await realpath(foreignDirectory);
      await expect(realpath(aliasPath)).resolves.toBe(canonicalForeignDirectory);

      now += 1_001;
      await expect(store.list()).resolves.toEqual([
        expect.objectContaining({ transactionToken, state: "failed" }),
      ]);
      await expect(realpath(aliasPath)).resolves.toBe(canonicalForeignDirectory);

      const replacementDirectory = path.join(root, "replacement");
      await mkdir(replacementDirectory);
      await rm(aliasPath);
      await symlink(replacementDirectory, aliasPath, "dir");
      const canonicalReplacementDirectory = await realpath(replacementDirectory);
      await expect(store.list()).resolves.toEqual([
        expect.objectContaining({ transactionToken, state: "failed" }),
      ]);
      await expect(realpath(aliasPath)).resolves.toBe(canonicalReplacementDirectory);

      await rm(aliasPath);
      await expect(store.list()).resolves.toEqual([]);
      await expect(realpath(foreignDirectory)).resolves.toBe(canonicalForeignDirectory);
      await expect(realpath(replacementDirectory)).resolves.toBe(canonicalReplacementDirectory);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
