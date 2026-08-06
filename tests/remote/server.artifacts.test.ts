import { describe, expect, test, vi } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, rm, readFile, stat, writeFile } from "node:fs/promises";
import {
  REMOTE_HEALTH_CLIENT_NONCE_HEADER,
  REMOTE_PROTOCOL_HEADER,
  REMOTE_REQUEST_PROOF_HEADER,
  REMOTE_SERVER_GENERATION_HEADER,
  RemoteRequestAuthenticator,
  createRemoteHealthAuthenticationProof,
} from "../../src/remote/auth.js";
import { RemoteArtifactStore } from "../../src/remote/artifactStore.js";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import type { BrowserRunResult } from "../../src/browserMode.js";
import type { BrowserRunTransaction } from "../../src/browser/types.js";
import { writeBinaryBrowserArtifact } from "../../src/browser/artifacts.js";
import {
  MAX_REMOTE_ARTIFACT_BYTES,
  MAX_REMOTE_ATTACHMENT_BYTES,
  MAX_REMOTE_ATTACHMENTS,
  MAX_REMOTE_PROMPT_CHARS,
  MAX_REMOTE_REQUEST_BYTES,
  MAX_REMOTE_TOTAL_ATTACHMENT_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  type RemoteArtifactDescriptor,
} from "../../src/remote/types.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import {
  completedBrowserCaptureCleanup,
  type BrowserCaptureSettlementAdapters,
} from "../../src/browser/runLifecycle.js";
import {
  CAN_LISTEN_LOCALHOST,
  createTestRemoteServer,
  browserTransaction,
  committedPromptEpoch,
  createArtifactDescriptor,
  lifecycleBrowserTransaction,
  remoteRunPayload,
} from "./serverTestBuilders.js";
import { httpPostJson, httpPostNdjson, readIncomingBody } from "./serverTestHttp.js";
import { openTestRemoteTransactionStore } from "./testTransactionStore.js";

describe("remote browser service", { timeout: 15_000 }, () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "publishes captured text with manual-copy fallback when artifact registration fails",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-fallback-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const missingArtifactPath = path.join(tmpDir, "missing.zip");
      const runtime: BrowserRunTransaction["runtime"] = {
        chromeTargetId: "artifact-fallback-target",
        recoveryCleanupResources: [
          {
            chromeTargetId: "artifact-fallback-target",
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      setOracleHomeDirOverrideForTest(tmpDir);
      const settleResources = vi.fn<BrowserCaptureSettlementAdapters["settleResources"]>(
        async (_mode, pendingRuntime) => completedBrowserCaptureCleanup(pendingRuntime),
      );
      const resumeBrowser = vi.fn(async () => {
        throw new Error("text-only fallback must not require browser recovery");
      });
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir,
          resumeBrowser,
          runBrowser: async (options) =>
            lifecycleBrowserTransaction(
              options.prompt,
              {
                answerText: "captured before artifact failure",
                answerMarkdown: "captured before artifact failure",
                tookMs: 1,
                answerTokens: 4,
                answerChars: 32,
                savedFiles: [
                  {
                    kind: "file",
                    path: missingArtifactPath,
                    label: "missing required artifact",
                    mimeType: "application/zip",
                    sizeBytes: 22,
                    sourceUrl: "sandbox:/mnt/data/missing.zip",
                    url: "browser-download",
                    finalUrl: "browser-download",
                    filename: "missing.zip",
                  },
                ],
              },
              runtime,
              options.runtimeHintCb,
              settleResources,
            ),
        },
      );

      try {
        const captured = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "a".repeat(64),
        })({ prompt: "preserve answer after artifact failure", config: {} });
        expect(captured).toMatchObject({
          answerText: "captured before artifact failure",
          warnings: [expect.objectContaining({ code: "remote-artifact-manual-copy-required" })],
        });
        await expect(captured.finalize()).resolves.toMatchObject({ status: "completed" });
        const records = await openTestRemoteTransactionStore({
          directory: transactionStoreDir,
          integrityKeyPath: path.join(
            path.dirname(transactionStoreDir),
            ".remote-transaction-integrity.key",
          ),
        }).then((store) => store.list());
        expect(records).toEqual([
          expect.objectContaining({
            state: "finalized",
            terminalAudit: expect.objectContaining({ artifacts: [] }),
          }),
        ]);
        expect(settleResources).toHaveBeenCalledOnce();
        expect(resumeBrowser).not.toHaveBeenCalled();
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "publishes captured text when artifact manifest enrichment cannot persist",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-enrichment-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const artifactPayload = Buffer.from([
        0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      const runtime: BrowserRunTransaction["runtime"] = {
        chromeTargetId: "artifact-enrichment-target",
        recoveryCleanupResources: [
          {
            chromeTargetId: "artifact-enrichment-target",
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      setOracleHomeDirOverrideForTest(tmpDir);
      const originalStageCapture = RemoteTransactionStore.prototype.stageCapture;
      const stageCapture = vi
        .spyOn(RemoteTransactionStore.prototype, "stageCapture")
        .mockImplementation(function (
          this: RemoteTransactionStore,
          params: Parameters<RemoteTransactionStore["stageCapture"]>[0],
        ) {
          if (params.artifacts?.length) {
            return Promise.reject(new Error("simulated artifact manifest persistence failure"));
          }
          return originalStageCapture.call(this, params);
        });
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) => {
            const artifact = await writeBinaryBrowserArtifact({
              sessionId: options.sessionId,
              artifactWriteAuthority: options.artifactWriteAuthority,
              kind: "file",
              filename: "result.zip",
              contents: artifactPayload,
              label: "result.zip",
              mimeType: "application/zip",
              sourceUrl: "sandbox:/mnt/data/result.zip",
            });
            if (!artifact) throw new Error("Expected artifact enrichment fixture");
            const result: BrowserRunResult = {
              answerText: "artifact enrichment answer",
              answerMarkdown: "artifact enrichment answer",
              tookMs: 1,
              answerTokens: 3,
              answerChars: 26,
              savedFiles: [
                {
                  ...artifact,
                  kind: "file",
                  url: "browser-download",
                  finalUrl: "browser-download",
                  filename: path.basename(artifact.path),
                },
              ],
            };
            const transaction = browserTransaction(options.prompt, result, runtime);
            await options.preArchiveCaptureCb?.(result, transaction.runtime);
            return transaction;
          },
        },
      );

      try {
        const captured = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "a".repeat(64),
        })({ prompt: "artifact enrichment persistence", config: {} });
        expect(captured).toMatchObject({
          answerText: "artifact enrichment answer",
          warnings: [expect.objectContaining({ code: "remote-artifact-manual-copy-required" })],
        });
        await expect(captured.finalize()).resolves.toMatchObject({ status: "completed" });
        const records = await openTestRemoteTransactionStore({
          directory: transactionStoreDir,
          integrityKeyPath: path.join(
            path.dirname(transactionStoreDir),
            ".remote-transaction-integrity.key",
          ),
        }).then((store) => store.list());
        expect(records).toEqual([
          expect.objectContaining({
            state: "finalized",
            terminalAudit: expect.objectContaining({ artifacts: [] }),
          }),
        ]);
        expect(stageCapture.mock.calls.filter(([params]) => params.artifacts?.length)).toHaveLength(
          1,
        );
      } finally {
        stageCapture.mockRestore();
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "publishes text-only fallback before 33 files can exceed the public transaction limit",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-count-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      setOracleHomeDirOverrideForTest(tmpDir);
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) =>
            browserTransaction(options.prompt, {
              answerText: "bounded artifact answer",
              answerMarkdown: "bounded artifact answer",
              tookMs: 1,
              answerTokens: 3,
              answerChars: 23,
              savedFiles: Array.from({ length: MAX_REMOTE_ATTACHMENTS + 1 }, (_, index) => ({
                kind: "file" as const,
                path: path.join(tmpDir, `host-only-${index}.zip`),
                label: `host-only-${index}.zip`,
                mimeType: "application/zip",
                sizeBytes: 1,
                sourceUrl: `sandbox:/mnt/data/host-only-${index}.zip`,
                url: "browser-download",
                finalUrl: "browser-download",
                filename: `host-only-${index}.zip`,
              })),
            }),
        },
      );

      try {
        const captured = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "a".repeat(64),
        })({ prompt: "bound generated file count", config: {} });
        expect(captured).toMatchObject({
          answerText: "bounded artifact answer",
          warnings: [expect.objectContaining({ code: "remote-artifact-manual-copy-required" })],
        });
        await expect(captured.finalize()).resolves.toMatchObject({ status: "completed" });
        const records = await openTestRemoteTransactionStore({
          directory: transactionStoreDir,
          integrityKeyPath: path.join(
            path.dirname(transactionStoreDir),
            ".remote-transaction-integrity.key",
          ),
        }).then((store) => store.list());
        expect(records).toEqual([
          expect.objectContaining({
            state: "finalized",
            terminalAudit: expect.objectContaining({ artifacts: [] }),
          }),
        ]);
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "transfers saved browser file artifacts to the client session directory",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-test-"));
      const clientHome = path.join(tmpDir, "client-home");
      setOracleHomeDirOverrideForTest(clientHome);
      const hostArtifactPaths: string[] = [];
      const emptyZip = Buffer.from([
        0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);

      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          runBrowser: async (options) => {
            const firstHostArtifact = await writeBinaryBrowserArtifact({
              sessionId: options.sessionId,
              artifactWriteAuthority: options.artifactWriteAuthority,
              kind: "file",
              filename: "host-result.zip",
              contents: emptyZip,
              label: "Download",
              mimeType: "application/octet-stream",
              sourceUrl: "sandbox:/mnt/data/result.zip",
            });
            const secondHostArtifact = await writeBinaryBrowserArtifact({
              sessionId: options.sessionId,
              artifactWriteAuthority: options.artifactWriteAuthority,
              kind: "file",
              filename: "host-result.zip",
              contents: emptyZip,
              label: "Download another result",
              mimeType: "application/zip",
              sourceUrl: "sandbox:/mnt/data/result.zip",
            });
            if (!firstHostArtifact || !secondHostArtifact) {
              throw new Error("Expected exact host artifact fixtures");
            }
            hostArtifactPaths.push(firstHostArtifact.path, secondHostArtifact.path);
            const result: BrowserRunResult = {
              answerText: "done",
              answerMarkdown: "done",
              tookMs: 1000,
              answerTokens: 1,
              answerChars: 4,
              savedFiles: [
                {
                  ...firstHostArtifact,
                  kind: "file",
                  url: "browser-download",
                  finalUrl: "browser-download",
                  filename: path.basename(firstHostArtifact.path),
                },
                {
                  ...secondHostArtifact,
                  kind: "file",
                  url: "browser-download",
                  finalUrl: "browser-download",
                  filename: path.basename(secondHostArtifact.path),
                },
              ],
              artifacts: [
                {
                  ...firstHostArtifact,
                  kind: "file",
                  label: "result.zip",
                  mimeType: "application/zip",
                },
              ],
              warnings: [
                {
                  code: "chatgpt-ui-warning",
                  severity: "warning",
                  message: "host-only warning /Users/private/profile",
                },
              ],
            };
            return browserTransaction(options.prompt, result);
          },
        },
      );

      const executor = createRemoteBrowserExecutor({
        host: `127.0.0.1:${server.port}`,
        token: "a".repeat(64),
      });
      const result = await executor({
        prompt: "remote",
        config: {},
        sessionId: "remote-artifact-session",
      });

      expect(result.answerText).toBe("done");
      await result.finalize();
      expect(result.warnings).toEqual([
        {
          code: "chatgpt-ui-warning",
          severity: "warning",
          message: "Remote browser host reported a warning.",
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("host-only warning /Users/private/profile");
      expect(result.artifacts).toHaveLength(2);
      const artifactsDir = path.join(
        clientHome,
        "sessions",
        "remote-artifact-session",
        "artifacts",
      );
      const artifact = result.artifacts?.[0];
      expect(path.dirname(artifact!.path)).toBe(artifactsDir);
      expect(path.basename(artifact!.path)).toMatch(/^artifact-[A-Za-z0-9_-]+\.zip$/u);
      expect(artifact?.path).not.toBe(hostArtifactPaths[0]);
      expect(artifact).toMatchObject({
        kind: "file",
        label: "host-result.zip",
        mimeType: "application/octet-stream",
        sizeBytes: emptyZip.length,
        sourceUrl: "bridge-artifact",
        validation: { type: "zip", ok: true },
        transfer: { status: "completed", bytes: emptyZip.length },
        origin: { mode: "bridge" },
      });
      expect(artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
      await expect(readFile(artifact!.path)).resolves.toEqual(emptyZip);
      const duplicate = result.artifacts?.[1];
      expect(path.dirname(duplicate!.path)).toBe(artifactsDir);
      expect(path.basename(duplicate!.path)).toMatch(/^artifact-[A-Za-z0-9_-]+\.zip$/u);
      expect(duplicate!.path).not.toBe(artifact!.path);
      expect(duplicate).toMatchObject({
        kind: "file",
        label: "host-result-2.zip",
        filename: expect.stringMatching(/^artifact-[A-Za-z0-9_-]+\.zip$/u),
      });
      await expect(readFile(duplicate!.path)).resolves.toEqual(emptyZip);
      await expect(stat(hostArtifactPaths[0]!)).resolves.toMatchObject({ size: emptyZip.length });
      await expect(stat(hostArtifactPaths[1]!)).resolves.toMatchObject({ size: emptyZip.length });

      await server.close();
      await rm(tmpDir, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    },
    15_000,
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "durably waives a required artifact after post-manifest client publication failure",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-waiver-"));
      const clientHome = path.join(tmpDir, "oracle-home");
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const clientSessionDirectory = path.join(clientHome, "sessions", "manual-copy-client");
      await mkdir(clientSessionDirectory, { recursive: true });
      await writeFile(path.join(clientSessionDirectory, "artifacts"), "block local publication");
      setOracleHomeDirOverrideForTest(clientHome);
      const payload = Buffer.from([
        0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      const answerText = "captured with artifact waiver";
      const runtime: BrowserRunTransaction["runtime"] = {
        chromeTargetId: "artifact-waiver-target",
        recoveryCleanupResources: [
          {
            chromeTargetId: "artifact-waiver-target",
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const settleResources = vi.fn<BrowserCaptureSettlementAdapters["settleResources"]>(
        async (_mode, pendingRuntime) => completedBrowserCaptureCleanup(pendingRuntime),
      );
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) => {
            const artifact = await writeBinaryBrowserArtifact({
              sessionId: options.sessionId,
              artifactWriteAuthority: options.artifactWriteAuthority,
              kind: "file",
              filename: "waived-result.zip",
              contents: payload,
              label: "waived-result.zip",
              mimeType: "application/zip",
              sourceUrl: "sandbox:/mnt/data/waived-result.zip",
            });
            if (!artifact) throw new Error("Expected required waiver artifact fixture");
            return lifecycleBrowserTransaction(
              options.prompt,
              {
                answerText,
                answerMarkdown: answerText,
                tookMs: 1,
                answerTokens: 4,
                answerChars: answerText.length,
                savedFiles: [
                  {
                    ...artifact,
                    kind: "file",
                    url: "browser-download",
                    finalUrl: "browser-download",
                    filename: path.basename(artifact.path),
                  },
                ],
              },
              runtime,
              options.runtimeHintCb,
              settleResources,
            );
          },
        },
      );
      const originalRecordManualCopyWaiver = RemoteArtifactStore.prototype.recordManualCopyWaiver;
      let injectedWaiverResponseFailure = false;
      const recordManualCopyWaiver = vi
        .spyOn(RemoteArtifactStore.prototype, "recordManualCopyWaiver")
        .mockImplementation(async function (
          this: RemoteArtifactStore,
          params: Parameters<RemoteArtifactStore["recordManualCopyWaiver"]>[0],
        ) {
          const waiver = await originalRecordManualCopyWaiver.call(this, params);
          if (!injectedWaiverResponseFailure) {
            injectedWaiverResponseFailure = true;
            throw new Error("simulated lost manual-copy waiver response");
          }
          return waiver;
        });

      try {
        const captured = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "a".repeat(64),
        })({
          prompt: "waive failed artifact transfer",
          config: {},
          sessionId: "manual-copy-client",
        });
        expect(captured).toMatchObject({
          answerText,
          warnings: [expect.objectContaining({ code: "remote-artifact-manual-copy-required" })],
        });
        expect(captured.warnings?.[0]?.message).toContain("Manual-copy waiver remains pending");
        expect(captured).not.toHaveProperty("artifacts");
        expect(captured).not.toHaveProperty("savedFiles");
        await expect(captured.finalize()).resolves.toMatchObject({ status: "completed" });
        const records = await openTestRemoteTransactionStore({
          directory: transactionStoreDir,
          integrityKeyPath: path.join(
            path.dirname(transactionStoreDir),
            ".remote-transaction-integrity.key",
          ),
        }).then((store) => store.list());
        expect(records).toEqual([
          expect.objectContaining({
            state: "finalized",
            finalization: { status: "completed", runtime: expect.any(Object) },
            terminalAudit: expect.objectContaining({
              settlementMode: "finalize",
              publicationAcknowledgedAt: expect.any(String),
              artifacts: [
                expect.objectContaining({
                  required: true,
                  manualCopyWaiver: {
                    waiverId: expect.stringMatching(/^[a-f0-9]{64}$/u),
                    waivedAt: expect.any(String),
                    disposition: "manual-copy-required",
                    byteSize: payload.length,
                    sha256: createHash("sha256").update(payload).digest("hex"),
                  },
                }),
              ],
            }),
          }),
        ]);
        expect(records[0]?.terminalAudit?.artifacts[0]).not.toHaveProperty("deliveryReceipt");
        expect(settleResources).toHaveBeenCalledOnce();
        expect(recordManualCopyWaiver).toHaveBeenCalledTimes(2);
      } finally {
        recordManualCopyWaiver.mockRestore();
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
    15_000,
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST).each([
    {
      name: "a different artifact",
      targetIndex: 1,
      body: (first: RemoteArtifactDescriptor) => ({
        sha256: first.sha256,
        byteSize: first.byteSize,
      }),
    },
    {
      name: "a mismatched byte size",
      targetIndex: 0,
      body: (first: RemoteArtifactDescriptor) => ({
        sha256: first.sha256,
        byteSize: first.byteSize + 1,
      }),
    },
    {
      name: "a mismatched hash",
      targetIndex: 0,
      body: (_first: RemoteArtifactDescriptor, second: RemoteArtifactDescriptor) => ({
        sha256: second.sha256,
        byteSize: second.byteSize,
      }),
    },
  ])(
    "rejects a schema-valid manual-copy waiver for $name and blocks finalization",
    async ({ targetIndex, body }) => {
      const tmpDir = await mkdtemp(
        path.join(os.tmpdir(), "oracle-remote-artifact-waiver-binding-"),
      );
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const transactionToken = "1".repeat(64);
      const firstPayload = Buffer.from("first artifact");
      const secondPayload = Buffer.from("second artifact with a different size");
      setOracleHomeDirOverrideForTest(tmpDir);
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) => {
            const [firstArtifact, secondArtifact] = await Promise.all(
              [
                { filename: "first.zip", contents: firstPayload },
                { filename: "second.zip", contents: secondPayload },
              ].map(async ({ filename, contents }) =>
                writeBinaryBrowserArtifact({
                  sessionId: options.sessionId,
                  artifactWriteAuthority: options.artifactWriteAuthority,
                  kind: "file",
                  filename,
                  contents,
                  label: filename,
                  mimeType: "application/zip",
                  sourceUrl: `sandbox:/mnt/data/${filename}`,
                }),
              ),
            );
            if (!firstArtifact || !secondArtifact) {
              throw new Error("Expected required waiver binding artifact fixtures");
            }
            return browserTransaction(options.prompt, {
              answerText: "captured with required artifacts",
              answerMarkdown: "captured with required artifacts",
              tookMs: 1,
              answerTokens: 4,
              answerChars: 32,
              savedFiles: [firstArtifact, secondArtifact].map((artifact) => ({
                ...artifact,
                kind: "file" as const,
                url: "browser-download",
                finalUrl: "browser-download",
                filename: path.basename(artifact.path),
              })),
            });
          },
        },
      );

      try {
        await expect(
          httpPostNdjson({
            hostname: "127.0.0.1",
            port: server.port,
            path: `/transactions/${transactionToken}/run`,
            token: "a".repeat(64),
            body: remoteRunPayload(),
          }),
        ).resolves.toMatchObject({ statusCode: 200 });
        const readCurrent = async () =>
          await openTestRemoteTransactionStore({
            directory: transactionStoreDir,
            integrityKeyPath: path.join(tmpDir, ".remote-transaction-integrity.key"),
          }).then((reader) => reader.read(transactionToken));
        const artifacts = (await readCurrent())?.artifacts;
        expect(artifacts).toHaveLength(2);
        const [first, second] = artifacts ?? [];
        if (!first || !second) throw new Error("Expected registered waiver binding artifacts");
        const waiver = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/artifacts/${encodeURIComponent(
            [first, second][targetIndex]!.descriptor.artifactId,
          )}/manual-copy-waiver`,
          token: "a".repeat(64),
          body: body(first.descriptor, second.descriptor),
        });
        expect(waiver).toMatchObject({
          statusCode: 409,
          json: { error: "artifact_manual_copy_waiver_conflict" },
        });
        const persistedArtifacts = (await readCurrent())?.artifacts;
        expect(persistedArtifacts).toHaveLength(2);
        expect(persistedArtifacts?.every((artifact) => !artifact.manualCopyWaiver)).toBe(true);
        await expect(
          httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: `/transactions/${transactionToken}/finalize`,
            token: "a".repeat(64),
            body: { durablePublication: true },
          }),
        ).resolves.toMatchObject({
          statusCode: 409,
          json: { error: "required_artifact_delivery_incomplete" },
        });
        for (const artifact of [first.descriptor, second.descriptor]) {
          await expect(
            httpPostJson({
              hostname: "127.0.0.1",
              port: server.port,
              path: `/transactions/${transactionToken}/artifacts/${encodeURIComponent(
                artifact.artifactId,
              )}/manual-copy-waiver`,
              token: "a".repeat(64),
              body: { sha256: artifact.sha256, byteSize: artifact.byteSize },
            }),
          ).resolves.toMatchObject({ statusCode: 200, json: { ok: true } });
        }
        await expect(
          httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: `/transactions/${transactionToken}/finalize`,
            token: "a".repeat(64),
            body: { durablePublication: true },
          }),
        ).resolves.toMatchObject({ statusCode: 200, json: { state: "finalized" } });
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "rejects untrusted artifact identifiers before creating local paths",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-invalid-artifact-"));
      setOracleHomeDirOverrideForTest(tmpDir);
      const payload = Buffer.from("zip");
      const bridge = await createFakeArtifactBridge({
        descriptor: createArtifactDescriptor(payload, { artifactId: "../../escape" }),
        payload,
      });

      try {
        await expect(
          createRemoteBrowserExecutor({
            host: `127.0.0.1:${bridge.port}`,
            token: "a".repeat(64),
          })({ prompt: "remote", config: {}, sessionId: "invalid-artifact-session" }),
        ).rejects.toMatchObject({
          name: "BrowserAutomationError",
          details: {
            stage: "remote-protocol",
            recoverableDisconnect: true,
            runtime: {
              recoveryCleanupResources: [
                {
                  recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
                  remoteRecovery: { state: "recoverable-error" },
                },
              ],
            },
          },
        });
        expect(bridge.artifactRequests()).toBe(0);
      } finally {
        await bridge.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "rejects a durable receipt bound to a different transaction token",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-token-binding-"));
      setOracleHomeDirOverrideForTest(tmpDir);
      const payload = Buffer.from("zip");
      const bridge = await createFakeArtifactBridge({
        descriptor: createArtifactDescriptor(payload),
        payload,
        transactionTokenOverride: "f".repeat(64),
      });

      try {
        await expect(
          createRemoteBrowserExecutor({
            host: `127.0.0.1:${bridge.port}`,
            token: "a".repeat(64),
          })({ prompt: "remote", config: {}, sessionId: "wrong-token-session" }),
        ).rejects.toMatchObject({
          name: "BrowserAutomationError",
          details: {
            stage: "remote-protocol",
            recoverableDisconnect: true,
            runtime: {
              recoveryCleanupResources: [
                {
                  recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
                  remoteRecovery: { state: "recoverable-error" },
                },
              ],
            },
          },
        });
        expect(bridge.artifactRequests()).toBe(0);
      } finally {
        await bridge.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "preserves captured text when a chunked artifact exceeds its declared size",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-oversize-artifact-"));
      setOracleHomeDirOverrideForTest(tmpDir);
      const declared = Buffer.from("zip");
      const bridge = await createFakeArtifactBridge({
        descriptor: createArtifactDescriptor(declared),
        payload: Buffer.from("zip plus undeclared bytes"),
      });
      const host = `127.0.0.1:${bridge.port}`;

      try {
        const captured = await createRemoteBrowserExecutor({
          host,
          token: "a".repeat(64),
        })({ prompt: "remote", config: {}, sessionId: "oversize-artifact-session" });
        expect(captured).toMatchObject({
          answerText: "done",
          warnings: [
            {
              code: "remote-artifact-manual-copy-required",
              severity: "warning",
              message: expect.stringContaining("artifact exceeded declared size"),
            },
          ],
        });
        expect(captured.warnings?.[0]?.message).toContain(`remote browser host ${host}`);
        expect(captured.warnings?.[0]?.message.length).toBeLessThanOrEqual(32_768);
        expect(captured).not.toHaveProperty("artifacts");
        expect(captured).not.toHaveProperty("savedFiles");
        expect(bridge.artifactRequests()).toBe(1);
        const artifactDir = path.join(tmpDir, "sessions", "oversize-artifact-session", "artifacts");
        expect(await readdir(artifactDir).catch(() => [])).toEqual([]);
        await expect(captured.finalize()).resolves.toMatchObject({ status: "completed" });
      } finally {
        await bridge.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );
});
function createAuthenticatedTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
): http.Server {
  const rootKey = "a".repeat(64);
  const serverGeneration = "remote-server-test-generation";
  const authenticator = new RemoteRequestAuthenticator({ rootKey, serverGeneration });
  const server = http.createServer();
  server.on("checkContinue", (req, res) => {
    const authentication = authenticator.authenticate(req);
    if ("statusCode" in authentication) {
      res.writeHead(authentication.statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: authentication.code }));
      return;
    }
    res.writeEarlyHints({
      link: "</health>; rel=preconnect",
      [REMOTE_SERVER_GENERATION_HEADER]: authentication.serverGeneration,
      [REMOTE_REQUEST_PROOF_HEADER]: authentication.requestProof,
    });
    res.writeContinue();
    server.emit("request", req, res);
  });
  server.on("request", (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const protocol = String(req.headers[REMOTE_PROTOCOL_HEADER] ?? "");
      const clientNonce = String(req.headers[REMOTE_HEALTH_CLIENT_NONCE_HEADER] ?? "");
      if (
        protocol !== String(REMOTE_TRANSACTION_PROTOCOL_VERSION) ||
        !/^[a-f0-9]{64}$/u.test(clientNonce)
      ) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "authentication_required" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          version: "test",
          uptimeSeconds: 1,
          capabilities: {
            artifactTransfer: true,
            artifactProtocolVersion: 1,
            transactionProtocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
            maxArtifactBytes: MAX_REMOTE_ARTIFACT_BYTES,
            maxRequestBytes: MAX_REMOTE_REQUEST_BYTES,
            maxAttachmentBytes: MAX_REMOTE_ATTACHMENT_BYTES,
            maxTotalAttachmentBytes: MAX_REMOTE_TOTAL_ATTACHMENT_BYTES,
            maxAttachments: MAX_REMOTE_ATTACHMENTS,
            maxPromptChars: MAX_REMOTE_PROMPT_CHARS,
            transportSecurity: "loopback-http",
            boundedRequestDeadlines: true,
            boundedTransactionStore: true,
          },
          authentication: createRemoteHealthAuthenticationProof({
            rootKey,
            serverGeneration,
            clientNonce,
          }),
        }),
      );
      return;
    }
    const authentication = authenticator.verified(req) ?? authenticator.authenticate(req);
    if ("statusCode" in authentication) {
      res.writeHead(authentication.statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: authentication.code }));
      return;
    }
    void handler(req, res).catch((error) => {
      if (res.headersSent) res.destroy(error instanceof Error ? error : new Error(String(error)));
      else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "test_handler_failed" }));
      }
    });
  });
  return server;
}

async function createFakeArtifactBridge({
  descriptor,
  payload,
  transactionTokenOverride,
}: {
  descriptor: RemoteArtifactDescriptor;
  payload: Buffer;
  transactionTokenOverride?: string;
}): Promise<{
  port: number;
  artifactRequests(): number;
  close(): Promise<void>;
}> {
  let artifactRequestCount = 0;
  let activeTransactionToken: string | null = null;
  let activePromptEpoch = committedPromptEpoch("remote");
  const server = createAuthenticatedTestServer(async (req, res) => {
    const runMatch = /^\/transactions\/([a-f0-9]{64})\/run$/u.exec(req.url ?? "");
    if (req.method === "POST" && runMatch) {
      const routeTransactionToken = runMatch[1]!;
      const runPayload = JSON.parse(await readIncomingBody(req)) as {
        prompt: string;
        transactionToken?: unknown;
      };
      if (runPayload.transactionToken !== undefined) {
        throw new Error("transaction token must not be serialized in the run body");
      }
      activeTransactionToken = routeTransactionToken;
      activePromptEpoch = committedPromptEpoch(runPayload.prompt);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(
        `${JSON.stringify({
          type: "transaction",
          transaction: {
            protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
            transactionToken: transactionTokenOverride ?? routeTransactionToken,
            runId: descriptor.runId,
            result: {
              answerText: "done",
              answerMarkdown: "done",
              tookMs: 1,
              answerTokens: 1,
              answerChars: 4,
            },
            runtime: { promptEpoch: activePromptEpoch, cleanup: { status: "pending" } },
            artifacts: [descriptor],
            state: "pending",
          },
        })}\n`,
      );
      return;
    }
    const bindMatch = /^\/transactions\/([a-f0-9]{64})\/bind$/u.exec(req.url ?? "");
    if (req.method === "POST" && bindMatch) {
      const body = JSON.parse(await readIncomingBody(req)) as { mode?: unknown };
      const mode = body.mode === "abort" ? "abort" : "finalize";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          transactionToken: bindMatch[1],
          settlementAuthority: { mode, outcome: "bound", state: "pending" },
          runtime: { promptEpoch: activePromptEpoch, cleanup: { status: "pending" } },
        }),
      );
      return;
    }
    const settlementMatch = /^\/transactions\/([a-f0-9]{64})\/(finalize|abort)$/.exec(
      req.url ?? "",
    );
    if (req.method === "POST" && settlementMatch) {
      await readIncomingBody(req);
      const mode = settlementMatch[2] === "abort" ? "abort" : "finalize";
      const state = mode === "finalize" ? "finalized" : "aborted";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          transactionToken: settlementMatch[1],
          state,
          settlementAuthority: { mode, outcome: "completed", state },
          finalization: {
            status: "completed",
            runtime: { promptEpoch: activePromptEpoch, cleanup: { status: "completed" } },
          },
        }),
      );
      return;
    }
    const artifactPath = activeTransactionToken
      ? `/transactions/${activeTransactionToken}/artifacts/${encodeURIComponent(descriptor.artifactId)}`
      : null;
    if (req.method === "POST" && artifactPath && req.url === `${artifactPath}/manual-copy-waiver`) {
      const body = JSON.parse(await readIncomingBody(req)) as {
        sha256?: unknown;
        byteSize?: unknown;
      };
      if (body.sha256 !== descriptor.sha256 || body.byteSize !== descriptor.byteSize) {
        throw new Error("manual-copy waiver did not match the artifact descriptor");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          artifactId: descriptor.artifactId,
          disposition: "manual-copy-required",
        }),
      );
      return;
    }
    if (req.method === "POST" && artifactPath && req.url === `${artifactPath}/receipt`) {
      await readIncomingBody(req);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && artifactPath && req.url === artifactPath) {
      artifactRequestCount += 1;
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "X-Oracle-Artifact-Sha256": descriptor.sha256,
      });
      res.write(payload);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const listenDeferred = Promise.withResolvers<void>();
  server.once("error", listenDeferred.reject);
  server.listen(0, "127.0.0.1", listenDeferred.resolve);
  await listenDeferred.promise;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake artifact bridge did not bind a TCP port");
  }
  return {
    port: address.port,
    artifactRequests: () => artifactRequestCount,
    close: async () => {
      const closeDeferred = Promise.withResolvers<void>();
      server.close((error) => (error ? closeDeferred.reject(error) : closeDeferred.resolve()));
      await closeDeferred.promise;
    },
  };
}
