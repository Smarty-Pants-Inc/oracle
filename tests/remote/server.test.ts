import { describe, expect, test, vi } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile, readFile, stat } from "node:fs/promises";
import {
  createRemoteServer,
  drainRemoteServerShutdown,
  __test__ as serverTest,
  type RemoteServerInstance,
} from "../../src/remote/server.js";
import {
  REMOTE_HEALTH_CLIENT_NONCE_HEADER,
  REMOTE_PROTOCOL_HEADER,
  REMOTE_REQUEST_PROOF_HEADER,
  REMOTE_SERVER_GENERATION_HEADER,
  RemoteRequestAuthenticator,
  createRemoteAuthenticatedRequest,
  createRemoteHealthAuthenticationProof,
  verifyRemoteRequestProof,
  type RemoteAuthenticatedRequest,
} from "../../src/remote/auth.js";
import { checkRemoteHealth } from "../../src/remote/health.js";
import { runBridgeHost } from "../../src/cli/bridge/host.js";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import {
  createRemoteBrowserExecutor,
  resumeRemoteBrowserTransaction,
  settleRemoteBrowserRecovery,
} from "../../src/remote/client.js";
import type { BrowserRunOptions, BrowserRunResult } from "../../src/browserMode.js";
import type { BrowserLogger, BrowserRunTransaction } from "../../src/browser/types.js";
import type { ReattachDeps, retryBrowserRecoveryCleanup } from "../../src/browser/reattach.js";
import type { BrowserSessionConfig } from "../../src/sessionManager.js";
import {
  buildRemotePromptRequestIdentity,
  MAX_REMOTE_ARTIFACT_BYTES,
  MAX_REMOTE_ATTACHMENT_BYTES,
  MAX_REMOTE_ATTACHMENTS,
  MAX_REMOTE_PROMPT_CHARS,
  MAX_REMOTE_REQUEST_BYTES,
  MAX_REMOTE_TOTAL_ATTACHMENT_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  type RemoteArtifactDescriptor,
  type RemoteRunPayload,
} from "../../src/remote/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { promptIdentitySha256 } from "../../src/browser/actions/promptComposer.js";
import {
  captureProfileDirectoryIdentity,
  readOracleChromeOwner,
  sameProfileDirectoryIdentity,
  writeOracleChromeOwner,
} from "../../src/browser/profileState.js";
import {
  BrowserCaptureSettlementController,
  completedBrowserCaptureCleanup,
  createBrowserRunTransaction,
  pendingBrowserCaptureCleanup,
  type BrowserCaptureSettlementAdapters,
} from "../../src/browser/runLifecycle.js";

const CAN_LISTEN_LOCALHOST =
  spawnSync(
    process.execPath,
    [
      "-e",
      `
      const net = require('net');
      const s = net.createServer();
      s.on('error', () => process.exit(1));
      s.listen(0, '127.0.0.1', () => s.close(() => process.exit(0)));
    `,
    ],
    { stdio: "ignore" },
  ).status === 0;

function committedPromptEpoch(
  prompt: string,
  conversationId = "remote-conversation",
  followUpOrdinal = 0,
) {
  return {
    status: "committed" as const,
    epochId: `epoch-${followUpOrdinal}`,
    promptSha256: promptIdentitySha256(prompt),
    baselineTurns: 0,
    followUpOrdinal,
    remainingFollowUps: 0,
    verifiedUserTurnIndex: followUpOrdinal,
    verifiedUserTurnId: `turn-${followUpOrdinal}`,
    verifiedUserMessageId: `message-${followUpOrdinal}`,
    conversationId,
  };
}

function browserTransaction(
  prompt: string,
  result: BrowserRunResult,
  runtime: BrowserRunTransaction["runtime"] = {},
  callbacks: {
    finalize?: BrowserRunTransaction["finalize"];
    abort?: BrowserRunTransaction["abort"];
  } = {},
  followUpOrdinal = 0,
): BrowserRunTransaction {
  const conversationId = result.conversationId?.trim() || "remote-conversation";
  const capturedRuntime: BrowserRunTransaction["runtime"] = {
    ...runtime,
    conversationId,
    promptEpoch: committedPromptEpoch(prompt, conversationId, followUpOrdinal),
  };
  return {
    ...result,
    conversationId,
    runtime: capturedRuntime,
    bindSettlement: async () => capturedRuntime,
    finalize:
      callbacks.finalize ?? (async () => ({ status: "completed", runtime: capturedRuntime })),
    abort: callbacks.abort ?? (async () => ({ status: "completed", runtime: capturedRuntime })),
  };
}

function lifecycleBrowserTransaction(
  prompt: string,
  result: BrowserRunResult,
  runtime: BrowserRunTransaction["runtime"],
  runtimeHintCb: BrowserRunOptions["runtimeHintCb"],
  settleResources: BrowserCaptureSettlementAdapters["settleResources"],
  followUpOrdinal = 0,
): BrowserRunTransaction {
  const conversationId = result.conversationId?.trim() || "remote-conversation";
  const capturedRuntime: BrowserRunTransaction["runtime"] = {
    ...runtime,
    conversationId,
    promptEpoch: committedPromptEpoch(prompt, conversationId, followUpOrdinal),
  };
  const settlement = new BrowserCaptureSettlementController(
    {
      persistRuntime: async (pendingRuntime) => {
        await runtimeHintCb?.(pendingRuntime);
      },
      settleResources,
    },
    capturedRuntime,
  );
  return createBrowserRunTransaction({ ...result, conversationId }, settlement);
}

describe("remote browser service", { timeout: 15_000 }, () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "keeps the legacy bearer scoped to predecessor health and text runs",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-legacy-auth-"));
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "v3-root-key",
          legacyToken: "legacy-bearer",
          logger: () => {},
        },
        { transactionStoreDir: path.join(tmpDir, "transactions") },
      );
      try {
        await expect(
          httpGetJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: "/health",
            headers: { authorization: "Bearer v3-root-key" },
          }),
        ).resolves.toMatchObject({ statusCode: 401 });
        await expect(
          httpGetJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: "/health",
            headers: { authorization: "Bearer legacy-bearer" },
          }),
        ).resolves.toMatchObject({ statusCode: 200, json: { ok: true } });
        await expect(
          httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: "/runs",
            body: {},
            headers: { authorization: "Bearer v3-root-key" },
          }),
        ).resolves.toMatchObject({ statusCode: 401 });
        await expect(
          httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: "/runs",
            body: {},
            headers: { authorization: "Bearer legacy-bearer" },
          }),
        ).resolves.toMatchObject({ statusCode: 400 });
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "returns canonical bound and completed authority on opposite-mode conflicts",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-http-conflict-"));
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir: path.join(tmpDir, "transactions"),
          runBrowser: async (options) =>
            browserTransaction(options.prompt, {
              answerText: "answer",
              answerMarkdown: "answer",
              tookMs: 1,
              answerTokens: 1,
              answerChars: 6,
            }),
        },
      );
      try {
        const transaction = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        })({ prompt: "canonical HTTP conflict", config: {} });
        const transactionToken = transaction.runtime.recoveryCleanupResources?.find(
          (resource) => resource.remoteRecovery,
        )?.remoteRecovery?.transactionToken;
        if (!transactionToken) throw new Error("missing remote transaction authority");

        await transaction.bindSettlement("finalize");
        await expect(
          httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: `/transactions/${transactionToken}/bind`,
            token: "secret",
            body: { mode: "abort", durablePublication: false },
          }),
        ).resolves.toMatchObject({
          statusCode: 409,
          json: {
            error: "transaction_settlement_conflict",
            settlementAuthority: { mode: "finalize", outcome: "bound", state: "pending" },
          },
        });

        await expect(transaction.finalize()).resolves.toMatchObject({ status: "completed" });
        await expect(
          httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: `/transactions/${transactionToken}/abort`,
            token: "secret",
            body: {},
          }),
        ).resolves.toMatchObject({
          statusCode: 409,
          json: {
            error: "transaction_already_settled",
            settlementAuthority: {
              mode: "finalize",
              outcome: "completed",
              state: "finalized",
            },
          },
        });
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "streams logs and returns results via client executor",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-test-"));
      const attachmentPath = path.join(tmpDir, "note.txt");
      const fallbackAttachmentPath = path.join(tmpDir, "fallback.txt");
      await writeFile(attachmentPath, "hello world", "utf8");
      await writeFile(fallbackAttachmentPath, "fallback world", "utf8");

      const transactionStoreDir = path.join(tmpDir, "remote-transactions");
      const hostRuntime: BrowserRunTransaction["runtime"] = {
        browserTransport: "cdp",
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeTargetId: "remote-target",
        conversationId: "remote-conversation",
        recoveryCleanupResources: [
          {
            chromeHost: "127.0.0.1",
            chromePort: 9222,
            chromeTargetId: "remote-target",
            conversationId: "remote-conversation",
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const finalize = vi.fn(async () => ({ status: "completed" as const, runtime: hostRuntime }));
      const runLog: string[] = [];
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async (options) => {
            runLog.push(options.prompt);
            expect(options.sessionId).toBe("remote-session-id");
            expect(options.followUpPrompts).toEqual(["follow up"]);
            expect(options.attachments).toHaveLength(1);
            const attachment = options.attachments?.[0];
            if (!attachment) {
              throw new Error("missing attachment");
            }
            const stored = await readFile(attachment.path, "utf8");
            expect(stored).toBe("hello world");
            expect(options.fallbackSubmission?.prompt).toBe("fallback prompt");
            expect(options.fallbackSubmission?.attachments).toHaveLength(1);
            const fallbackAttachment = options.fallbackSubmission?.attachments[0];
            if (!fallbackAttachment) {
              throw new Error("missing fallback attachment");
            }
            const fallbackStored = await readFile(fallbackAttachment.path, "utf8");
            expect(fallbackStored).toBe("fallback world");
            options.log?.("uploading attachment");
            const result: BrowserRunResult = {
              answerText: "hi",
              answerMarkdown: "hi",
              tookMs: 1000,
              answerTokens: 42,
              answerChars: 2,
            };
            return browserTransaction("follow up", result, hostRuntime, { finalize }, 1);
          },
          transactionStoreDir,
        },
      );

      const executor = createRemoteBrowserExecutor({
        host: `127.0.0.1:${server.port}`,
        token: "secret",
      });
      const clientLogs: string[] = [];
      const result = await executor({
        prompt: "remote",
        attachments: [{ path: attachmentPath, displayPath: "note.txt", sizeBytes: 11 }],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [
            { path: fallbackAttachmentPath, displayPath: "fallback.txt", sizeBytes: 14 },
          ],
        },
        config: {},
        sessionId: "remote-session-id",
        followUpPrompts: ["follow up"],
        log: (message?: string) => {
          if (message) clientLogs.push(message);
        },
      });

      expect(clientLogs.some((entry) => entry.includes("uploading attachment"))).toBe(true);
      expect(result.answerText).toBe("hi");
      expect(runLog).toEqual(["remote"]);
      expect(finalize).not.toHaveBeenCalled();
      expect(result.runtime).toMatchObject({
        promptEpoch: {
          status: "committed",
          promptSha256: promptIdentitySha256("follow up"),
          followUpOrdinal: 1,
          verifiedUserTurnId: "turn-1",
          verifiedUserMessageId: "message-1",
          conversationId: "remote-conversation",
        },
        recoveryCleanupResources: [
          {
            recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
            remoteRecovery: { state: "pending" },
          },
        ],
      });
      expect(JSON.stringify(result.runtime)).not.toContain("remote-target");
      expect(JSON.stringify(result.runtime)).not.toContain("9222");
      const recordName = (await readdir(transactionStoreDir)).find((name) =>
        name.endsWith(".json"),
      );
      if (!recordName) throw new Error("missing durable remote transaction record");
      if (process.platform !== "win32") {
        expect((await stat(transactionStoreDir)).mode & 0o777).toBe(0o700);
        expect((await stat(path.join(transactionStoreDir, recordName))).mode & 0o777).toBe(0o600);
      }
      const pendingRecord = JSON.parse(
        await readFile(path.join(transactionStoreDir, recordName), "utf8"),
      );
      expect(pendingRecord).toMatchObject({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        state: "pending",
        result: { answerText: "hi" },
        runtime: { chromePort: 9222, chromeTargetId: "remote-target" },
        requestIdentity: {
          acceptedPromptSha256: [promptIdentitySha256("follow up")],
          followUpOrdinal: 1,
          remainingFollowUps: 0,
        },
        browserConfig: {
          chatgptUrl: "https://chatgpt.com/",
          remoteChrome: null,
          attachRunning: false,
        },
        leaseExpiresAt: expect.any(String),
      });
      await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
      await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
      expect(finalize).toHaveBeenCalledTimes(1);
      const finalizedRecord = JSON.parse(
        await readFile(path.join(transactionStoreDir, recordName), "utf8"),
      );
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
      expect(finalizedRecord).not.toHaveProperty("requestIdentity");
      expect(finalizedRecord).not.toHaveProperty("browserConfig");
      expect(finalizedRecord).not.toHaveProperty("leaseExpiresAt");
      expect(JSON.stringify(finalizedRecord)).not.toContain("remote-target");
      expect(JSON.stringify(finalizedRecord)).not.toContain("answerText");

      const healthUnauthorized = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/health",
      });
      expect(healthUnauthorized.statusCode).toBe(401);

      const healthOk = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/health",
        token: "secret",
      });
      expect(healthOk.statusCode).toBe(200);
      expect(healthOk.json?.ok).toBe(true);
      expect(typeof healthOk.json?.version).toBe("string");
      expect(healthOk.json?.capabilities).toMatchObject({
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
      });

      const artifactUnauthorized = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: `/transactions/${"a".repeat(64)}/artifacts/artifact-id`,
      });
      expect(artifactUnauthorized.statusCode).toBe(401);

      const malformedArtifactPath = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/transactions/%E0%A4%A/artifacts/artifact-id",
        token: "secret",
      });
      expect(malformedArtifactPath.statusCode).toBe(404);

      const healthAfterMalformedPath = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/health",
        token: "secret",
      });
      expect(healthAfterMalformedPath.statusCode).toBe(200);

      await server.close();
      await rm(tmpDir, { recursive: true, force: true });
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST).each(["finalize", "abort"] as const)(
    "persists the exact bound %s runtime before executing live cleanup",
    async (mode) => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), `oracle-remote-${mode}-runtime-`));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const cleanupMarker = path.join(tmpDir, "cleanup-pending");
      await writeFile(cleanupMarker, "owned", "utf8");
      const cleanupModes: Array<"finalize" | "abort"> = [];
      const runtime: BrowserRunTransaction["runtime"] = {
        chromeTargetId: `${mode}-target`,
        recoveryCleanupResources: [
          {
            chromeTargetId: `${mode}-target`,
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) =>
            lifecycleBrowserTransaction(
              options.prompt,
              {
                answerText: mode,
                answerMarkdown: mode,
                tookMs: 1,
                answerTokens: 1,
                answerChars: mode.length,
              },
              runtime,
              options.runtimeHintCb,
              async (settlementMode, pendingRuntime) => {
                cleanupModes.push(settlementMode);
                await rm(cleanupMarker);
                return completedBrowserCaptureCleanup(pendingRuntime);
              },
            ),
        },
      );

      try {
        const transaction = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        })({ prompt: `${mode} exact settlement`, config: {} });
        expect(existsSync(cleanupMarker)).toBe(true);
        await expect(transaction[mode]()).resolves.toMatchObject({ status: "completed" });
        expect(cleanupModes).toEqual([mode]);
        expect(existsSync(cleanupMarker)).toBe(false);
        const oppositeMode = mode === "finalize" ? "abort" : "finalize";
        await expect(transaction[oppositeMode]()).rejects.toMatchObject({
          details: { code: "settlement-mode-conflict" },
        });

        const recordName = (await readdir(transactionStoreDir)).find((name) =>
          name.endsWith(".json"),
        );
        if (!recordName) throw new Error("missing durable remote transaction record");
        await expect(
          readFile(path.join(transactionStoreDir, recordName), "utf8"),
        ).resolves.toContain(`"settlementMode": "${mode}"`);
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "durably publishes a captured answer before finalizing after required artifact preparation fails",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-pending-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const missingArtifactPath = path.join(
        tmpDir,
        "sessions",
        "artifact-pending-session",
        "artifacts",
        "missing.zip",
      );
      const runtime: BrowserRunTransaction["runtime"] = {
        chromeTargetId: "artifact-pending-target",
        recoveryCleanupResources: [
          {
            chromeTargetId: "artifact-pending-target",
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
      await mkdir(path.dirname(missingArtifactPath), { recursive: true });
      const settleResources = vi.fn<BrowserCaptureSettlementAdapters["settleResources"]>(
        async (mode, pendingRuntime) => {
          expect(mode).toBe("finalize");
          return completedBrowserCaptureCleanup(pendingRuntime);
        },
      );
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
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
        const transaction = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        })({ prompt: "preserve answer after artifact failure", config: {} });
        const publishedResult = {
          answerText: "captured before artifact failure",
          answerMarkdown: "captured before artifact failure",
          warnings: [
            {
              code: "remote-artifact-preparation-pending",
              severity: "warning",
              message: "Remote browser host reported a warning.",
            },
          ],
          tookMs: 1,
          answerTokens: 4,
          answerChars: 32,
        };

        expect(transaction).toMatchObject(publishedResult);
        expect(settleResources).not.toHaveBeenCalled();

        const recordName = (await readdir(transactionStoreDir)).find((name) =>
          name.endsWith(".json"),
        );
        if (!recordName) throw new Error("missing captured artifact failure transaction");
        const recordPath = path.join(transactionStoreDir, recordName);
        const pendingRecord = JSON.parse(await readFile(recordPath, "utf8"));
        expect(pendingRecord).toMatchObject({
          state: "pending",
          requestIdentity: {
            acceptedPromptSha256: [promptIdentitySha256("preserve answer after artifact failure")],
          },
        });
        expect(pendingRecord.result).toEqual(publishedResult);
        expect(pendingRecord).not.toHaveProperty("artifacts");

        const pendingRetry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${pendingRecord.transactionToken}/retry`,
          token: "secret",
          body: {},
        });
        expect(pendingRetry).toMatchObject({
          statusCode: 200,
          json: {
            status: "transaction",
            transaction: { state: "pending", result: publishedResult },
          },
        });
        expect(JSON.parse(await readFile(recordPath, "utf8")).result).toEqual(publishedResult);

        const firstFinalization = await transaction.finalize();
        await expect(transaction.finalize()).resolves.toEqual(firstFinalization);
        expect(firstFinalization).toMatchObject({ status: "completed" });
        expect(settleResources).toHaveBeenCalledOnce();

        const finalizedRecordText = await readFile(recordPath, "utf8");
        const finalizedRecord = JSON.parse(finalizedRecordText);
        expect(finalizedRecord).toMatchObject({
          state: "finalized",
          terminalAudit: {
            settlementMode: "finalize",
            publicationAcknowledgedAt: expect.any(String),
          },
          finalization: { status: "completed" },
        });
        expect(finalizedRecord).not.toHaveProperty("result");

        const retry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${pendingRecord.transactionToken}/retry`,
          token: "secret",
          body: {},
        });
        expect(retry).toMatchObject({
          statusCode: 200,
          json: {
            status: "terminal",
            transactionToken: pendingRecord.transactionToken,
            outcome: { state: "finalized", finalization: { status: "completed" } },
          },
        });
        await expect(readFile(recordPath, "utf8")).resolves.toBe(finalizedRecordText);
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "keeps manual-login Chrome but requests completed run-tab cleanup",
    async () => {
      const manualLoginProfileDir = "/tmp/oracle-manual-login-profile-test";
      const cleanupPolicies: Array<boolean | undefined> = [];
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          manualLoginDefault: true,
          manualLoginProfileDir,
        },
        {
          runBrowser: async (options) => {
            expect(options.config).toMatchObject({
              manualLogin: true,
              manualLoginProfileDir,
              keepBrowser: true,
            });
            cleanupPolicies.push(options.closeOwnedTabOnComplete);
            return browserTransaction(options.prompt, {
              answerText: "done",
              answerMarkdown: "done",
              tookMs: 1,
              answerTokens: 1,
              answerChars: 4,
            });
          },
        },
      );

      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        });
        const result = await executor({
          prompt: "remote manual-login cleanup",
          config: {},
        });

        expect(result.answerText).toBe("done");
        await result.finalize();

        const explicitlyKept = await executor({
          prompt: "remote manual-login explicit keep",
          config: { keepBrowser: true },
        });

        expect(explicitlyKept.answerText).toBe("done");
        await explicitlyKept.finalize();
        expect(cleanupPolicies).toEqual([true, false]);
      } finally {
        await server.close();
      }
    },
    15_000,
  );

  test("serve bootstrap releases retained endpoint authority without killing Chrome", async () => {
    const kill = vi.fn(async () => ({ status: "stopped" as const, pid: 4321 }));
    const release = vi.fn(async () => undefined);
    const owner = {
      chrome: {
        pid: 4321,
        port: 9222,
        processIdentity: { pid: 4321 },
        kill,
      },
      processIdentity: { pid: 4321 },
      source: "recorded" as const,
      disposition: "preserve" as const,
      endpointAuthority: {
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/serve-bootstrap",
        kill,
        release,
      },
    };
    const acquireOwner = vi.fn(async () => owner);
    const logger = vi.fn<(message: string) => void>();

    await serverTest.bootstrapRemoteManualChromeOwner("/tmp/oracle-serve-bootstrap", logger, {
      acquireOwner: acquireOwner as never,
    });

    expect(acquireOwner).toHaveBeenCalledWith(
      "/tmp/oracle-serve-bootstrap",
      expect.objectContaining({ manualLogin: true, keepBrowser: true }),
      logger,
      "remote-serve-bootstrap",
    );
    expect(release).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();

    const announcementFailure = new Error("bootstrap announcement failed");
    await expect(
      serverTest.bootstrapRemoteManualChromeOwner(
        "/tmp/oracle-serve-bootstrap",
        vi.fn(() => {
          throw announcementFailure;
        }) as BrowserLogger,
        { acquireOwner: acquireOwner as never },
      ),
    ).rejects.toBe(announcementFailure);
    expect(release).toHaveBeenCalledTimes(2);
    expect(kill).not.toHaveBeenCalled();
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "transfers saved browser file artifacts to the client session directory",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-test-"));
      const clientHome = path.join(tmpDir, "client-home");
      setOracleHomeDirOverrideForTest(clientHome);
      const hostArtifactPath = path.join(
        clientHome,
        "sessions",
        "host-session",
        "artifacts",
        "host-result.zip",
      );
      const secondHostArtifactPath = path.join(
        clientHome,
        "sessions",
        "second-host-session",
        "artifacts",
        "host-result.zip",
      );
      const emptyZip = Buffer.from([
        0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      await mkdir(path.dirname(hostArtifactPath), { recursive: true });
      await mkdir(path.dirname(secondHostArtifactPath), { recursive: true });
      await writeFile(hostArtifactPath, emptyZip);
      await writeFile(secondHostArtifactPath, emptyZip);

      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async (options) => {
            const result: BrowserRunResult = {
              answerText: "done",
              answerMarkdown: "done",
              tookMs: 1000,
              answerTokens: 1,
              answerChars: 4,
              savedFiles: [
                {
                  kind: "file",
                  path: hostArtifactPath,
                  label: "Download",
                  mimeType: "application/octet-stream",
                  sizeBytes: emptyZip.length,
                  sourceUrl: "sandbox:/mnt/data/result.zip",
                  url: "browser-download",
                  finalUrl: "browser-download",
                  filename: "result.zip",
                },
                {
                  kind: "file",
                  path: secondHostArtifactPath,
                  label: "Download another result",
                  mimeType: "application/zip",
                  sizeBytes: emptyZip.length,
                  sourceUrl: "sandbox:/mnt/data/result.zip",
                  url: "browser-download",
                  finalUrl: "browser-download",
                  filename: "result.zip",
                },
              ],
              artifacts: [
                {
                  kind: "file",
                  path: hostArtifactPath,
                  label: "result.zip",
                  mimeType: "application/zip",
                  sizeBytes: emptyZip.length,
                  sourceUrl: "sandbox:/mnt/data/result.zip",
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
        token: "secret",
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
      expect(artifact?.path).not.toBe(hostArtifactPath);
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
        label: "host-result.zip",
        filename: expect.stringMatching(/^artifact-[A-Za-z0-9_-]+\.zip$/u),
      });
      await expect(readFile(duplicate!.path)).resolves.toEqual(emptyZip);
      await expect(stat(hostArtifactPath)).resolves.toMatchObject({ size: emptyZip.length });
      await expect(stat(secondHostArtifactPath)).resolves.toMatchObject({
        size: emptyZip.length,
      });

      await server.close();
      await rm(tmpDir, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    },
    15_000,
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
            token: "secret",
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
            token: "secret",
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
    "stops chunked artifact downloads that exceed the declared size",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-oversize-artifact-"));
      setOracleHomeDirOverrideForTest(tmpDir);
      const declared = Buffer.from("zip");
      const bridge = await createFakeArtifactBridge({
        descriptor: createArtifactDescriptor(declared),
        payload: Buffer.from("zip plus undeclared bytes"),
      });

      try {
        await expect(
          createRemoteBrowserExecutor({
            host: `127.0.0.1:${bridge.port}`,
            token: "secret",
          })({ prompt: "remote", config: {}, sessionId: "oversize-artifact-session" }),
        ).rejects.toMatchObject({
          name: "BrowserAutomationError",
          message: expect.stringContaining("artifact exceeded declared size"),
          details: {
            stage: "remote-artifact-transfer",
            recoverableDisconnect: true,
            runtime: {
              recoveryCleanupResources: [
                {
                  recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
                  remoteRecovery: { state: "pending" },
                },
              ],
            },
          },
        });
        expect(bridge.artifactRequests()).toBe(1);
        const artifactDir = path.join(tmpDir, "sessions", "oversize-artifact-session", "artifacts");
        expect(await readdir(artifactDir).catch(() => [])).toEqual([]);
      } finally {
        await bridge.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "rejects authority-bearing config and oversized attachments before browser execution",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-dto-test-"));
      const runBrowser = vi.fn(async () =>
        browserTransaction("remote test", {
          answerText: "unexpected",
          answerMarkdown: "unexpected",
          tookMs: 1,
          answerTokens: 1,
          answerChars: 10,
        }),
      );
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        { runBrowser, transactionStoreDir: path.join(tmpDir, "transactions") },
      );

      try {
        const authorityResponse = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${"1".repeat(64)}/run`,
          token: "secret",
          body: {
            ...remoteRunPayload(),
            browserConfig: { remoteChrome: { host: "attacker.invalid", port: 9222 } },
          },
        });
        expect(authorityResponse).toMatchObject({
          statusCode: 400,
          json: { error: "authority_fields_rejected" },
        });

        const oversizeResponse = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${"2".repeat(64)}/run`,
          token: "secret",
          body: {
            ...remoteRunPayload(),
            attachments: [
              {
                fileName: "oversize.bin",
                displayPath: "oversize.bin",
                sizeBytes: MAX_REMOTE_ATTACHMENT_BYTES + 1,
                contentBase64: "YQ==",
              },
            ],
          },
        });
        expect(oversizeResponse.statusCode).toBe(413);
        expect(runBrowser).not.toHaveBeenCalled();
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "preserves a durable pending transaction when the response disconnects before acknowledgement",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-disconnect-test-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const runStarted = Promise.withResolvers<void>();
      const continueRun = Promise.withResolvers<void>();
      const runtime: BrowserRunTransaction["runtime"] = {
        chromePort: 9222,
        chromeTargetId: "disconnect-target",
        recoveryCleanupResources: [
          {
            chromePort: 9222,
            chromeTargetId: "disconnect-target",
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const finalize = vi.fn(async () => ({ status: "completed" as const, runtime }));
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) => {
            runStarted.resolve();
            options.log?.("capture started");
            await continueRun.promise;
            return browserTransaction(
              options.prompt,
              {
                answerText: "durable answer",
                answerMarkdown: "durable answer",
                tookMs: 1,
                answerTokens: 2,
                answerChars: 14,
              },
              runtime,
              { finalize },
            );
          },
        },
      );
      const transactionToken = "3".repeat(64);

      try {
        const disconnected = postJsonAndDisconnect({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/run`,
          token: "secret",
          body: remoteRunPayload(),
        });
        await runStarted.promise;
        await disconnected;
        continueRun.resolve();

        let retryResponse: Awaited<ReturnType<typeof httpPostJson>> | null = null;
        await vi.waitFor(async () => {
          retryResponse = await httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: `/transactions/${transactionToken}/retry`,
            token: "secret",
            body: {},
          });
          expect(retryResponse).toMatchObject({
            statusCode: 200,
            json: {
              status: "transaction",
              transaction: { state: "pending", result: { answerText: "durable answer" } },
            },
          });
        });
        expect(finalize).not.toHaveBeenCalled();
        const recordName = (await readdir(transactionStoreDir)).find((name) =>
          name.endsWith(".json"),
        );
        if (!recordName) throw new Error("missing disconnected transaction record");
        expect(
          JSON.parse(await readFile(path.join(transactionStoreDir, recordName), "utf8")),
        ).toMatchObject({ state: "pending", runtime: { chromeTargetId: "disconnect-target" } });

        await vi.waitFor(async () => {
          const settlement = await httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: `/transactions/${transactionToken}/finalize`,
            token: "secret",
            body: { durablePublication: true },
          });
          expect(settlement).toMatchObject({ statusCode: 200, json: { state: "finalized" } });
        });
        expect(finalize).toHaveBeenCalledTimes(1);
      } finally {
        continueRun.resolve();
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    15_000,
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "keeps controller authority until a disconnected receipt mutation settles",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-receipt-drain-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const controllerLockPath = path.join(transactionStoreDir, ".controller.lock");
      const artifactPath = path.join(
        tmpDir,
        "sessions",
        "receipt-session",
        "artifacts",
        "result.zip",
      );
      const artifactPayload = Buffer.from([
        0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      const transactionToken = "4".repeat(64);
      const mutationStarted = Promise.withResolvers<void>();
      const allowMutationFailure = Promise.withResolvers<void>();
      setOracleHomeDirOverrideForTest(tmpDir);
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, artifactPayload);
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) =>
            browserTransaction(options.prompt, {
              answerText: "durable answer",
              answerMarkdown: "durable answer",
              tookMs: 1,
              answerTokens: 2,
              answerChars: 14,
              savedFiles: [
                {
                  kind: "file",
                  path: artifactPath,
                  label: "receipt artifact",
                  mimeType: "application/zip",
                  sizeBytes: artifactPayload.length,
                  sourceUrl: "sandbox:/mnt/data/result.zip",
                  url: "browser-download",
                  finalUrl: "browser-download",
                  filename: "result.zip",
                },
              ],
            }),
        },
      );
      const recordArtifactDelivery = vi
        .spyOn(RemoteTransactionStore.prototype, "recordArtifactDelivery")
        .mockImplementation(async () => {
          mutationStarted.resolve();
          await allowMutationFailure.promise;
          throw new Error("simulated receipt mutation failure");
        });

      try {
        const run = await httpPostNdjson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/run`,
          token: "secret",
          body: remoteRunPayload(),
        });
        const transaction = run.events.find((event) => event.type === "transaction")
          ?.transaction as
          | { artifacts?: Array<{ artifactId: string; sha256: string; byteSize: number }> }
          | undefined;
        const artifact = transaction?.artifacts?.[0];
        if (!artifact) throw new Error("missing durable artifact receipt target");

        const receiptPath = `/transactions/${transactionToken}/artifacts/${artifact.artifactId}/receipt`;
        const receiptBody = Buffer.from(
          JSON.stringify({ sha256: artifact.sha256, byteSize: artifact.byteSize }),
        );
        const receiptAuthentication = await prepareTestAuthentication({
          hostname: "127.0.0.1",
          port: server.port,
          path: receiptPath,
          token: "secret",
          method: "POST",
          body: receiptBody,
        });
        const receiptRequest = http.request({
          hostname: "127.0.0.1",
          port: server.port,
          path: receiptPath,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": receiptBody.byteLength,
            Expect: "100-continue",
            ...(receiptAuthentication ? receiptAuthentication.authentication.headers : {}),
          },
        });
        receiptRequest.on("error", () => {});
        sendTestRequestBody({
          req: receiptRequest,
          authentication: receiptAuthentication,
          method: "POST",
          path: receiptPath,
          body: receiptBody,
        });
        await mutationStarted.promise;
        receiptRequest.destroy();

        const close = server.close();
        let closeSettled = false;
        void close.then(
          () => {
            closeSettled = true;
          },
          () => {
            closeSettled = true;
          },
        );
        await Promise.resolve();
        expect(closeSettled).toBe(false);
        expect(existsSync(controllerLockPath)).toBe(true);
        await expect(
          createRemoteServer(
            { host: "127.0.0.1", port: 0, token: "another-secret", logger: () => {} },
            { transactionStoreDir },
          ),
        ).rejects.toThrow();

        allowMutationFailure.reject(new Error("allow simulated receipt mutation failure"));
        await close;
        expect(existsSync(controllerLockPath)).toBe(false);
      } finally {
        allowMutationFailure.resolve();
        recordArtifactDelivery.mockRestore();
        await server.close().catch(() => undefined);
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "keeps the bridge tunnel and controller authority until an in-flight run reaches durable shutdown handoff",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-graceful-drain-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const controllerLockPath = path.join(transactionStoreDir, ".controller.lock");
      const connectionPath = path.join(tmpDir, "bridge-connection.json");
      const runStarted = Promise.withResolvers<void>();
      const continueRun = Promise.withResolvers<void>();
      const shutdownRequested = Promise.withResolvers<void>();
      const tunnelStarted = Promise.withResolvers<void>();
      const transactionToken = "5".repeat(64);
      const rejectedTransactionToken = "6".repeat(64);
      const recordPath = path.join(transactionStoreDir, `${transactionToken}.json`);
      const runtime: BrowserRunTransaction["runtime"] = {
        chromePort: 9222,
        chromeTargetId: "graceful-drain-target",
      };
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) => {
            runStarted.resolve();
            await continueRun.promise;
            return browserTransaction(
              options.prompt,
              {
                answerText: "durable shutdown answer",
                answerMarkdown: "durable shutdown answer",
                tookMs: 1,
                answerTokens: 3,
                answerChars: 23,
              },
              runtime,
            );
          },
        },
      );
      let hostPromise: Promise<void> | undefined;
      let hostSettled = false;
      let lockPresentAtTunnelStop: boolean | undefined;
      let recordAtTunnelStop: Record<string, unknown> | undefined;
      let listenerProbeAtTunnelStop: Promise<unknown> | undefined;
      const stopTunnel = vi.fn(() => {
        lockPresentAtTunnelStop = existsSync(controllerLockPath);
        recordAtTunnelStop = JSON.parse(readFileSync(recordPath, "utf8")) as Record<
          string,
          unknown
        >;
        listenerProbeAtTunnelStop = httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${rejectedTransactionToken}/run`,
          body: remoteRunPayload(),
        }).then(
          (response) =>
            new Error(
              `remote listener still accepted work during tunnel teardown: ${JSON.stringify(response)}`,
            ),
          (error: unknown) => error,
        );
      });

      try {
        hostPromise = runBridgeHost(
          {
            bind: `127.0.0.1:${server.port}`,
            token: "secret",
            writeConnection: connectionPath,
            ssh: "synthetic-bridge-host",
          },
          {
            serveRemote: () =>
              drainRemoteServerShutdown(server, shutdownRequested.promise, {
                logger: () => {},
                retryDelayMs: 1,
              }),
            startReverseTunnel: () => {
              tunnelStarted.resolve();
              return { stop: stopTunnel };
            },
          },
        );
        void hostPromise.then(
          () => {
            hostSettled = true;
          },
          () => {
            hostSettled = true;
          },
        );
        await tunnelStarted.promise;

        const runRequest = httpPostNdjson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/run`,
          token: "secret",
          body: remoteRunPayload(),
        });
        await runStarted.promise;
        shutdownRequested.resolve();

        await vi.waitFor(async () => {
          await expect(
            httpPostJson({
              hostname: "127.0.0.1",
              port: server.port,
              path: `/transactions/${rejectedTransactionToken}/run`,
              token: "secret",
              body: remoteRunPayload(),
            }),
          ).resolves.toMatchObject({
            statusCode: 503,
            json: { error: "server_closing" },
          });
        });

        const explicitClose = server.close();
        let explicitCloseSettled = false;
        void explicitClose.then(
          () => {
            explicitCloseSettled = true;
          },
          () => {
            explicitCloseSettled = true;
          },
        );
        await Promise.resolve();
        expect(explicitCloseSettled).toBe(false);
        expect(hostSettled).toBe(false);
        expect(stopTunnel).not.toHaveBeenCalled();
        expect(existsSync(controllerLockPath)).toBe(true);

        continueRun.resolve();
        const runResponse = await runRequest;
        expect(runResponse.statusCode).toBe(200);
        expect(runResponse.events.find((event) => event.type === "transaction")).toMatchObject({
          transaction: {
            transactionToken,
            state: "pending",
            result: { answerText: "durable shutdown answer" },
          },
        });

        await explicitClose;
        await hostPromise;
        expect(stopTunnel).toHaveBeenCalledOnce();
        expect(lockPresentAtTunnelStop).toBe(false);
        expect(recordAtTunnelStop).toMatchObject({
          state: "pending",
          result: { answerText: "durable shutdown answer" },
          runtime: { chromeTargetId: "graceful-drain-target" },
        });
        if (!listenerProbeAtTunnelStop) throw new Error("missing listener teardown probe");
        const listenerError = await listenerProbeAtTunnelStop;
        expect(listenerError).toBeInstanceOf(Error);
        expect(["ECONNREFUSED", "ECONNRESET"]).toContain(
          (listenerError as NodeJS.ErrnoException).code,
        );
        await expect(server.close()).resolves.toBeUndefined();
      } finally {
        continueRun.resolve();
        shutdownRequested.resolve();
        await hostPromise?.catch(() => undefined);
        await server.close().catch(() => undefined);
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "preserves an unacknowledged artifact capture across graceful restart and resumes delivery",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-shutdown-handoff-"));
      const oracleHome = path.join(tmpDir, "oracle-home");
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const hostArtifactPath = path.join(
        oracleHome,
        "sessions",
        "host-session",
        "artifacts",
        "handoff-result.zip",
      );
      const emptyZip = Buffer.from([
        0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      const payload = remoteRunPayload();
      const requestIdentity = buildRemotePromptRequestIdentity(payload);
      const transactionToken = "4".repeat(64);
      const runtime: BrowserRunTransaction["runtime"] = {
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeTargetId: "shutdown-handoff-target",
        recoveryCleanupResources: [
          {
            chromeHost: "127.0.0.1",
            chromePort: 9222,
            chromeTargetId: "shutdown-handoff-target",
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const finalize = vi.fn(async () => ({ status: "completed" as const, runtime }));
      const abort = vi.fn(async () => ({ status: "completed" as const, runtime }));
      let first: RemoteServerInstance | undefined;
      let restarted: RemoteServerInstance | undefined;
      setOracleHomeDirOverrideForTest(oracleHome);

      try {
        await mkdir(path.dirname(hostArtifactPath), { recursive: true });
        await writeFile(hostArtifactPath, emptyZip);
        first = await createRemoteServer(
          { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
          {
            transactionStoreDir,
            controllerGeneration: "controller-before-graceful-shutdown",
            runBrowser: async (options) =>
              browserTransaction(
                options.prompt,
                {
                  answerText: "restart-safe answer",
                  answerMarkdown: "restart-safe answer",
                  tookMs: 1,
                  answerTokens: 2,
                  answerChars: 19,
                  savedFiles: [
                    {
                      kind: "file",
                      path: hostArtifactPath,
                      label: "handoff result",
                      mimeType: "application/zip",
                      sizeBytes: emptyZip.length,
                      sourceUrl: "sandbox:/mnt/data/handoff-result.zip",
                      url: "browser-download",
                      finalUrl: "browser-download",
                      filename: "handoff-result.zip",
                    },
                  ],
                },
                runtime,
                { finalize, abort },
              ),
          },
        );
        const port = first.port;
        const host = `127.0.0.1:${port}`;
        const initial = await httpPostNdjson({
          hostname: "127.0.0.1",
          port,
          path: `/transactions/${transactionToken}/run`,
          token: "secret",
          body: payload,
        });
        expect(initial.statusCode).toBe(200);
        expect(initial.events.find((event) => event.type === "transaction")).toMatchObject({
          transaction: {
            transactionToken,
            state: "pending",
            result: { answerText: "restart-safe answer" },
            artifacts: [{ required: true }],
          },
        });

        const recordPath = path.join(transactionStoreDir, `${transactionToken}.json`);
        const pendingBeforeClose = await readFile(recordPath, "utf8");
        const pendingRecord = JSON.parse(pendingBeforeClose);
        expect(pendingRecord).toMatchObject({
          state: "pending",
          result: { answerText: "restart-safe answer" },
          runtime: { chromeTargetId: "shutdown-handoff-target" },
          artifacts: [{ canonicalPath: await realpath(hostArtifactPath) }],
        });
        expect(pendingRecord).not.toHaveProperty("settlementMode");
        expect(pendingRecord).not.toHaveProperty("publicationAcknowledgedAt");
        expect(pendingRecord).not.toHaveProperty("finalization");

        await first.close();
        first = undefined;
        expect(finalize).not.toHaveBeenCalled();
        expect(abort).not.toHaveBeenCalled();
        await expect(readFile(recordPath, "utf8")).resolves.toBe(pendingBeforeClose);

        const retryCleanup = vi.fn(
          async (
            settlementRuntime: BrowserRunTransaction["runtime"],
            _logger: unknown,
            _deps: unknown,
            mode?: "finalize" | "abort",
          ) => {
            expect(mode).toBe("finalize");
            return { status: "completed" as const, runtime: settlementRuntime };
          },
        );
        restarted = await createRemoteServer(
          { host: "127.0.0.1", port, token: "secret", logger: () => {} },
          {
            transactionStoreDir,
            controllerGeneration: "controller-after-graceful-shutdown",
            retryCleanup,
          },
        );
        const resumed = await resumeRemoteBrowserTransaction({
          runtime: {
            recoveryCleanupResources: [
              {
                remoteRecovery: {
                  protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
                  host,
                  transactionToken,
                  state: "pre-receipt",
                  requestIdentity,
                },
                recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
              },
            ],
          },
          configuredHost: host,
          authToken: "secret",
          sessionId: "shutdown-handoff-client",
        });
        expect(resumed.answerText).toBe("restart-safe answer");
        expect(resumed.artifacts).toHaveLength(1);
        await expect(readFile(resumed.artifacts![0]!.path)).resolves.toEqual(emptyZip);
        const deliveredRecord = JSON.parse(await readFile(recordPath, "utf8"));
        expect(deliveredRecord).toMatchObject({
          state: "pending",
          result: { answerText: "restart-safe answer" },
          runtime: { chromeTargetId: "shutdown-handoff-target" },
          artifacts: [{ deliveryReceipt: { byteSize: emptyZip.length } }],
        });
        expect(deliveredRecord).not.toHaveProperty("settlementMode");
        expect(deliveredRecord).not.toHaveProperty("publicationAcknowledgedAt");

        await expect(resumed.finalize()).resolves.toMatchObject({ status: "completed" });
        expect(retryCleanup).toHaveBeenCalledOnce();
        expect(retryCleanup.mock.calls[0]?.[3]).toBe("finalize");
        expect(finalize).not.toHaveBeenCalled();
        expect(abort).not.toHaveBeenCalled();
        await expect(resumed.abort()).rejects.toMatchObject({
          name: "BrowserAutomationError",
          details: { code: "settlement-mode-conflict" },
        });
        const finalizedRecord = JSON.parse(await readFile(recordPath, "utf8"));
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
      } finally {
        await restarted?.close().catch(() => undefined);
        await first?.close().catch(() => undefined);
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
    30_000,
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "retries partial live cleanup only in its durable settlement mode",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-finalize-retry-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const firstCleanupMarker = path.join(tmpDir, "first-cleanup-pending");
      const secondCleanupMarker = path.join(tmpDir, "second-cleanup-pending");
      await writeFile(firstCleanupMarker, "owned", "utf8");
      await writeFile(secondCleanupMarker, "owned", "utf8");
      const runtime: BrowserRunTransaction["runtime"] = {
        chromePort: 9222,
        recoveryCleanupResources: [
          {
            chromePort: 9222,
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      let cleanupAttempts = 0;
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) =>
            lifecycleBrowserTransaction(
              options.prompt,
              {
                answerText: "done",
                answerMarkdown: "done",
                tookMs: 1,
                answerTokens: 1,
                answerChars: 4,
              },
              runtime,
              options.runtimeHintCb,
              async (settlementMode, pendingRuntime) => {
                cleanupAttempts += 1;
                if (cleanupAttempts === 1) {
                  await rm(firstCleanupMarker);
                  return pendingBrowserCaptureCleanup(
                    pendingRuntime,
                    "Chrome still busy at /private/host/profile via ws://127.0.0.1:9222/private",
                    settlementMode,
                  );
                }
                await rm(secondCleanupMarker);
                return completedBrowserCaptureCleanup(pendingRuntime);
              },
            ),
        },
      );

      try {
        const transaction = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        })({ prompt: "retry cleanup", config: {} });
        const firstFinalization = await transaction.finalize();
        expect(firstFinalization).toMatchObject({
          status: "pending",
          runtime: {
            recoveryCleanupResources: [{ remoteRecovery: { state: "pending" } }],
            recoveryCleanupResult: { status: "failed", settlementMode: "finalize" },
          },
        });
        if (firstFinalization.status !== "pending") {
          throw new Error("expected first remote cleanup finalization to remain pending");
        }
        expect(firstFinalization.error).toBe(
          "Remote browser cleanup remains pending; retry the same settlement mode.",
        );
        expect(firstFinalization.error).not.toContain("/private/host/profile");
        expect(firstFinalization.error).not.toContain("ws://");
        expect(cleanupAttempts).toBe(1);
        expect(existsSync(firstCleanupMarker)).toBe(false);
        expect(existsSync(secondCleanupMarker)).toBe(true);
        await expect(transaction.abort()).rejects.toMatchObject({
          details: { code: "settlement-mode-conflict" },
        });
        expect(cleanupAttempts).toBe(1);

        const recordName = (await readdir(transactionStoreDir)).find((name) =>
          name.endsWith(".json"),
        );
        if (!recordName) throw new Error("missing durable remote transaction record");
        const partialRecord = JSON.parse(
          await readFile(path.join(transactionStoreDir, recordName), "utf8"),
        );
        expect(partialRecord).toMatchObject({
          state: "pending",
          settlementMode: "finalize",
          runtime: {
            recoveryCleanupResult: { status: "failed", settlementMode: "finalize" },
          },
          finalization: { status: "pending" },
        });

        await expect(
          settleRemoteBrowserRecovery({
            runtime: firstFinalization.runtime,
            configuredHost: `127.0.0.1:${server.port}`,
            authToken: "secret",
          }),
        ).resolves.toMatchObject({ status: "completed" });
        expect(cleanupAttempts).toBe(2);
        expect(existsSync(secondCleanupMarker)).toBe(false);
        await expect(transaction.finalize()).resolves.toMatchObject({ status: "completed" });
        expect(cleanupAttempts).toBe(2);
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "preserves browser-WSS runtime authority through the same remote transaction contract",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-wss-test-"));
      const runtime: BrowserRunTransaction["runtime"] = {
        recoveryCleanupResources: [
          {
            chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/older-wss-authority",
            chromeTargetId: "older-wss-target",
            recoveryCleanup: {
              ownsTarget: false,
              profileKind: "none",
              keepBrowser: true,
            },
          },
          {
            chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/wss-authority",
            chromeTargetId: "wss-target",
            recoveryCleanup: {
              ownsTarget: false,
              profileKind: "none",
              keepBrowser: true,
            },
          },
        ],
      };
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir: path.join(tmpDir, "transactions"),
          runBrowser: async (options) =>
            browserTransaction(
              options.prompt,
              {
                answerText: "wss",
                answerMarkdown: "wss",
                tookMs: 1,
                answerTokens: 1,
                answerChars: 3,
              },
              runtime,
            ),
        },
      );

      try {
        const transaction = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        })({ prompt: "WSS contract", config: {} });
        expect(transaction.runtime).toMatchObject({
          promptEpoch: {
            promptSha256: promptIdentitySha256("WSS contract"),
            conversationId: "remote-conversation",
          },
          recoveryCleanupResources: [
            {
              recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
              remoteRecovery: { state: "pending" },
            },
          ],
        });
        expect(transaction.runtime).not.toHaveProperty("chromePort");
        expect(transaction.runtime).not.toHaveProperty("chromeBrowserWSEndpoint");
        expect(transaction.runtime).not.toHaveProperty("chromeTargetId");
        for (const resource of transaction.runtime.recoveryCleanupResources ?? []) {
          expect(resource).not.toHaveProperty("chromePort");
          expect(resource).not.toHaveProperty("chromeBrowserWSEndpoint");
          expect(resource).not.toHaveProperty("chromeTargetId");
        }
        const finalization = await transaction.finalize();
        expect(finalization).toMatchObject({ status: "completed" });
        expect(finalization.runtime.recoveryCleanupResources).toBeUndefined();
        expect(finalization.runtime).not.toHaveProperty("remoteRecovery");
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "rehydrates and settles structured recoverable browser disconnect errors",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-error-test-"));
      const recoverableRuntime: BrowserRunTransaction["runtime"] = {
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch("recover"),
        recoveryCleanupResources: [
          {
            chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/recoverable",
            chromeTargetId: "recoverable-target",
            recoveryCleanup: {
              ownsTarget: false,
              profileKind: "none",
              keepBrowser: true,
            },
          },
        ],
      };
      const retryCleanup = vi.fn(async () => ({
        status: "completed" as const,
        runtime: recoverableRuntime,
      }));
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir: path.join(tmpDir, "transactions"),
          retryCleanup,
          runBrowser: async () => {
            throw new BrowserAutomationError("Browser WebSocket disconnected", {
              stage: "wait-for-answer",
              recoverableDisconnect: true,
              runtime: recoverableRuntime,
            });
          },
        },
      );

      try {
        const caught = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        })({ prompt: "recover", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toMatchObject({
          name: "BrowserAutomationError",
          details: {
            stage: "wait-for-answer",
            recoverableDisconnect: true,
            runtime: {
              promptEpoch: {
                promptSha256: promptIdentitySha256("recover"),
                verifiedUserTurnId: "turn-0",
                verifiedUserMessageId: "message-0",
                conversationId: "remote-conversation",
              },
              recoveryCleanupResources: [
                {
                  recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
                  remoteRecovery: { state: "recoverable-error" },
                },
              ],
            },
          },
        });
        if (!(caught instanceof BrowserAutomationError)) {
          throw new Error("expected a recoverable BrowserAutomationError");
        }
        const runtime = caught.details?.runtime as BrowserRunTransaction["runtime"] | undefined;
        const remoteAuthority = runtime?.recoveryCleanupResources?.find(
          (resource) => resource.remoteRecovery,
        )?.remoteRecovery;
        if (!remoteAuthority) throw new Error("missing remote recovery authority");
        expect(runtime).not.toHaveProperty("remoteRecovery");
        expect(remoteAuthority).not.toHaveProperty("settlementMode");

        await expect(
          settleRemoteBrowserRecovery({
            runtime,
            configuredHost: `127.0.0.1:${server.port}`,
            authToken: "secret",
          }),
        ).resolves.toMatchObject({ status: "completed" });
        expect(retryCleanup).toHaveBeenCalledOnce();
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "captures a recoverable answer after controller restart using journaled host authority",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-restart-capture-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const cleanupMarker = path.join(tmpDir, "recovered-cleanup-pending");
      await writeFile(cleanupMarker, "owned", "utf8");
      let transactionToken = "";
      const prompt = "recover after restart";
      const runtime: BrowserRunTransaction["runtime"] = {
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeTargetId: "restart-target",
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch(prompt),
        recoveryCleanupResources: [
          {
            chromeHost: "127.0.0.1",
            chromePort: 9222,
            chromeTargetId: "restart-target",
            conversationId: "remote-conversation",
            promptEpoch: committedPromptEpoch(prompt),
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const first = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async () => {
            throw new BrowserAutomationError("Browser disconnected", {
              stage: "wait-for-answer",
              recoverableDisconnect: true,
              runtime,
            });
          },
        },
      );
      try {
        const caught = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${first.port}`,
          token: "secret",
        })({ prompt, config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toMatchObject({ details: { recoverableDisconnect: true } });
        transactionToken = remoteRecoveryTransactionToken(caught);
      } finally {
        await first.close();
      }

      const cleanupModes: Array<"finalize" | "abort"> = [];
      const resumeBrowser = vi.fn(
        async (
          journaledRuntime: BrowserRunTransaction["runtime"],
          browserConfig: BrowserSessionConfig | undefined,
          _logger: BrowserLogger,
          deps: ReattachDeps = {},
        ) => {
          expect(journaledRuntime).toMatchObject({
            chromePort: 9222,
            chromeTargetId: "restart-target",
          });
          expect(browserConfig).toMatchObject({
            chatgptUrl: "https://chatgpt.com/",
            remoteChrome: null,
            attachRunning: false,
          });
          const transaction = lifecycleBrowserTransaction(
            prompt,
            {
              answerText: "recovered answer",
              answerMarkdown: "recovered answer",
              tookMs: 1,
              answerTokens: 2,
              answerChars: 16,
            },
            journaledRuntime,
            deps.runtimeHintCb,
            async (settlementMode, pendingRuntime) => {
              cleanupModes.push(settlementMode);
              await rm(cleanupMarker);
              return completedBrowserCaptureCleanup(pendingRuntime);
            },
          );
          return {
            answerText: transaction.answerText,
            answerMarkdown: transaction.answerMarkdown,
            runtime: transaction.runtime,
            bindSettlement: transaction.bindSettlement,
            finalize: transaction.finalize,
            abort: transaction.abort,
          };
        },
      );
      const restarted = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        { transactionStoreDir, resumeBrowser },
      );
      try {
        const retry = await httpPostJson({
          hostname: "127.0.0.1",
          port: restarted.port,
          path: `/transactions/${transactionToken}/retry`,
          token: "secret",
          body: {},
        });
        expect(retry).toMatchObject({
          statusCode: 200,
          json: {
            status: "transaction",
            transaction: {
              state: "pending",
              result: { answerText: "recovered answer" },
            },
          },
        });
        const responseRuntime = (retry.json?.transaction as { runtime?: unknown } | undefined)
          ?.runtime;
        expect(responseRuntime).toStrictEqual({
          promptEpoch: committedPromptEpoch(prompt),
          cleanup: { status: "pending" },
        });
        expect(resumeBrowser).toHaveBeenCalledOnce();

        const settlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: restarted.port,
          path: `/transactions/${transactionToken}/finalize`,
          token: "secret",
          body: { durablePublication: true },
        });
        expect(settlement).toMatchObject({ statusCode: 200, json: { state: "finalized" } });
        expect(cleanupModes).toEqual(["finalize"]);
        expect(existsSync(cleanupMarker)).toBe(false);
      } finally {
        await restarted.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    15_000,
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "aborts cleanup-only committed epochs after restart without answer recapture",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-followup-cleanup-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const transactionToken = "6".repeat(64);
      const prompt = "partial turn must not resume";
      const promptEpoch = {
        ...committedPromptEpoch(prompt),
        remainingFollowUps: 1,
      };
      const runtime: BrowserRunTransaction["runtime"] = {
        browserTransport: "cdp",
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeTargetId: "partial-followup-target",
        conversationId: "remote-conversation",
        promptEpoch,
        recoveryCleanupResources: [
          {
            chromeHost: "127.0.0.1",
            chromePort: 9222,
            chromeTargetId: "partial-followup-target",
            conversationId: "remote-conversation",
            promptEpoch,
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "none",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const stagedPromptEpoch = committedPromptEpoch(prompt);
      const stagedRuntime: BrowserRunTransaction["runtime"] = {
        ...runtime,
        promptEpoch: stagedPromptEpoch,
        recoveryCleanupResources: runtime.recoveryCleanupResources?.map((resource) => ({
          ...resource,
          promptEpoch: stagedPromptEpoch,
        })),
      };
      const beforeCrash = await RemoteTransactionStore.open({
        directory: transactionStoreDir,
        controllerGeneration: "controller-before-partial-followup",
      });
      await beforeCrash.begin({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        transactionToken,
        runId: "run-partial-followup",
        createdAt: new Date().toISOString(),
        requestIdentity: {
          acceptedPromptSha256: [promptIdentitySha256(prompt)],
          followUpOrdinal: 0,
          remainingFollowUps: 0,
        },
        browserConfig: { chatgptUrl: "https://chatgpt.com/" },
      });
      await beforeCrash.stageCapture({
        transactionToken,
        runId: "run-partial-followup",
        result: {
          answerText: "partial answer must not publish",
          answerMarkdown: "partial answer must not publish",
          tookMs: 1,
          answerTokens: 5,
          answerChars: 31,
        },
        runtime: stagedRuntime,
      });
      await beforeCrash.journalRuntime(transactionToken, runtime);

      const resumeBrowser = vi.fn();
      const retryCleanup = vi.fn(
        async (
          cleanupRuntime: BrowserRunTransaction["runtime"],
          _logger: unknown,
          _deps: unknown,
          mode?: "finalize" | "abort",
        ) => {
          expect(mode).toBe("abort");
          expect(cleanupRuntime).toMatchObject({
            promptEpoch,
            recoveryCleanupResult: { status: "pending", settlementMode: "abort" },
            recoveryCleanupResources: [
              expect.objectContaining({ chromeTargetId: "partial-followup-target" }),
            ],
          });
          return completedBrowserCaptureCleanup(cleanupRuntime);
        },
      );
      const restarted = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          controllerGeneration: "controller-after-partial-followup",
          resumeBrowser,
          retryCleanup,
        },
      );
      try {
        const retry = await httpPostJson({
          hostname: "127.0.0.1",
          port: restarted.port,
          path: `/transactions/${transactionToken}/retry`,
          token: "secret",
          body: {},
        });
        expect(retry).toMatchObject({
          statusCode: 200,
          json: {
            status: "terminal",
            outcome: {
              state: "aborted",
              finalization: {
                status: "completed",
                runtime: { promptEpoch, cleanup: { status: "completed" } },
              },
            },
          },
        });
        expect(retry.json).not.toHaveProperty("transaction.result");
        expect(resumeBrowser).not.toHaveBeenCalled();
        expect(retryCleanup).toHaveBeenCalledOnce();

        const reloaded = await RemoteTransactionStore.open({
          directory: transactionStoreDir,
          controllerGeneration: "partial-followup-reader",
        });
        const settled = await reloaded.read(transactionToken);
        expect(settled).toMatchObject({
          state: "aborted",
          terminalAudit: { settlementMode: "abort" },
          finalization: { status: "completed" },
        });
        expect(settled).not.toHaveProperty("settlementMode");
        expect(settled).not.toHaveProperty("runtime");
        expect(settled).not.toHaveProperty("result");
        expect(settled).not.toHaveProperty("stagedCapture");
      } finally {
        await restarted.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    15_000,
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "durably journals each recovery acquisition hint under the current controller before continuing",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-retry-runtime-hints-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const previousControllerGeneration = "controller-before-recovery";
      const recoveryControllerGeneration = "controller-after-recovery";
      const prompt = "recovery acquisition journal";
      const profileDirectory = {
        version: 1 as const,
        platform: process.platform,
        canonicalPath: "/tmp/oracle-retry-runtime-hints",
        device: "1",
        inode: "2",
      };
      const preIntent: BrowserRunTransaction["runtime"] = {
        browserTransport: "cdp",
        chromeHost: "127.0.0.1",
        chromeProfileRoot: "/tmp/oracle-retry-runtime-hints",
        userDataDir: "/tmp/oracle-retry-runtime-hints",
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch(prompt),
        recoveryCleanupResources: [
          {
            chromeHost: "127.0.0.1",
            chromeProfileRoot: "/tmp/oracle-retry-runtime-hints",
            userDataDir: "/tmp/oracle-retry-runtime-hints",
            conversationId: "remote-conversation",
            promptEpoch: committedPromptEpoch(prompt),
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
      const acquiredProcess: BrowserRunTransaction["runtime"] = {
        ...preIntent,
        chromePid: 4242,
        chromePort: 9222,
        chromeProcessIdentity: {
          pid: 4242,
          processStartTime: "123",
          executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          normalizedUserDataDir: "/tmp/oracle-retry-runtime-hints",
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
              normalizedUserDataDir: "/tmp/oracle-retry-runtime-hints",
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
      const acquiredTarget: BrowserRunTransaction["runtime"] = {
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
      const transactionToken = "7".repeat(64);
      const previousController = await RemoteTransactionStore.open({
        directory: transactionStoreDir,
        controllerGeneration: previousControllerGeneration,
      });
      await seedRemoteTransaction(previousController, transactionToken, {
        prompt,
        state: "running",
        runtime: preIntent,
      });

      const order: string[] = [];
      const assertReloadedRuntime = async (
        stage: "pre-intent" | "process" | "target",
        runtime: BrowserRunTransaction["runtime"],
      ) => {
        const reloaded = await RemoteTransactionStore.open({
          directory: transactionStoreDir,
          controllerGeneration: recoveryControllerGeneration,
        });
        await expect(reloaded.read(transactionToken)).resolves.toMatchObject({
          state: "recoverable-error",
          controllerGeneration: recoveryControllerGeneration,
          runtime,
        });
        order.push(`persist:${stage}`);
      };
      const finalize = vi.fn(async () => ({
        status: "completed" as const,
        runtime: acquiredTarget,
      }));
      const abort = vi.fn(async () => ({ status: "completed" as const, runtime: acquiredTarget }));
      const resumeBrowser = vi.fn(
        async (
          _runtime: BrowserRunTransaction["runtime"],
          _config: BrowserSessionConfig | undefined,
          _logger: BrowserLogger,
          deps?: ReattachDeps,
        ) => {
          const runtimeHintCb = deps?.runtimeHintCb;
          if (!runtimeHintCb) throw new Error("remote retry must provide a runtime hint callback");
          await runtimeHintCb(preIntent);
          await assertReloadedRuntime("pre-intent", preIntent);
          order.push("acquire:process");
          await runtimeHintCb(acquiredProcess);
          await assertReloadedRuntime("process", acquiredProcess);
          order.push("acquire:target");
          await runtimeHintCb(acquiredTarget);
          await assertReloadedRuntime("target", acquiredTarget);
          return {
            answerText: "recovered answer",
            answerMarkdown: "recovered answer",
            conversationId: "remote-conversation",
            runtime: acquiredTarget,
            bindSettlement: vi.fn(async () => acquiredTarget),
            finalize,
            abort,
          };
        },
      );
      const restarted = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          controllerGeneration: recoveryControllerGeneration,
          resumeBrowser,
        },
      );
      try {
        await expect(
          httpPostJson({
            hostname: "127.0.0.1",
            port: restarted.port,
            path: `/transactions/${transactionToken}/retry`,
            token: "secret",
            body: {},
          }),
        ).resolves.toMatchObject({
          statusCode: 200,
          json: { status: "transaction", transaction: { state: "pending" } },
        });
        expect(order).toEqual([
          "persist:pre-intent",
          "acquire:process",
          "persist:process",
          "acquire:target",
          "persist:target",
        ]);
        expect(resumeBrowser).toHaveBeenCalledOnce();
      } finally {
        await restarted.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    15_000,
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "projects abort authority after recovered capture failure with pending cleanup",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-identity-mismatch-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      let transactionToken = "";
      const prompt = "identity-bound prompt";
      const runtime: BrowserRunTransaction["runtime"] = {
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch(prompt),
      };
      const mismatchedRuntime: BrowserRunTransaction["runtime"] = {
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch("different prompt"),
      };
      const pendingAbort = {
        status: "pending" as const,
        runtime: mismatchedRuntime,
        error: "abort cleanup remains pending",
      };
      const abort = vi
        .fn<BrowserRunTransaction["abort"]>()
        .mockResolvedValueOnce(pendingAbort)
        .mockResolvedValueOnce(pendingAbort)
        .mockResolvedValueOnce({ status: "completed", runtime: mismatchedRuntime });
      const resumeBrowser = vi.fn(async () => ({
        answerText: "wrong answer",
        answerMarkdown: "wrong answer",
        runtime: mismatchedRuntime,
        bindSettlement: vi.fn(async () => mismatchedRuntime),
        finalize: vi.fn(async () => ({ status: "completed" as const, runtime: mismatchedRuntime })),
        abort,
      }));
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          resumeBrowser,
          runBrowser: async () => {
            throw new BrowserAutomationError("Browser disconnected", {
              stage: "wait-for-answer",
              recoverableDisconnect: true,
              runtime,
            });
          },
        },
      );
      try {
        const caught = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        })({ prompt, config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toMatchObject({ details: { recoverableDisconnect: true } });
        transactionToken = remoteRecoveryTransactionToken(caught);

        const retry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/retry`,
          token: "secret",
          body: {},
        });
        expect(retry).toMatchObject({
          statusCode: 200,
          json: {
            error: {
              code: "remote-prompt-authority-mismatch",
              recoverableDisconnect: true,
              settlementMode: "abort",
            },
          },
        });
        expect(abort).toHaveBeenCalledOnce();
        const record = await RemoteTransactionStore.open({
          directory: transactionStoreDir,
        }).then((store) => store.read(transactionToken));
        expect(record).toMatchObject({
          state: "recoverable-error",
          settlementMode: "abort",
          finalization: { status: "pending" },
        });
        await expect(server.close()).rejects.toThrow("cleanup remains pending");
        expect(abort).toHaveBeenCalledTimes(2);
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "settles restart-persisted launched Chrome authority only through the exact cleanup capability",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-restart-cleanup-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-remote-restart-"));
      const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
      const canonicalProfileDir = profileDirectory.canonicalPath;
      const identity = {
        pid: process.pid,
        processStartTime: "test-live-launched-owner",
        executablePath:
          process.platform === "win32"
            ? path.resolve(process.execPath).toLowerCase()
            : path.resolve(process.execPath),
        normalizedUserDataDir:
          process.platform === "win32"
            ? profileDirectory.canonicalPath.toLowerCase()
            : profileDirectory.canonicalPath,
        launchNonce: "12345678-1234-4123-8123-123456789abc",
        profileDirectory,
      };
      const chromePort = 45_678;
      await writeOracleChromeOwner(canonicalProfileDir, {
        port: chromePort,
        processIdentity: identity,
        disposition: "close-on-last-lease",
      });
      const prompt = "restart cleanup authority";
      const transactionToken = "d".repeat(64);
      const runtime: BrowserRunTransaction["runtime"] = {
        chromePid: identity.pid,
        chromeProcessIdentity: identity,
        chromePort,
        chromeHost: "127.0.0.1",
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch(prompt),
        recoveryCleanupResources: [
          {
            chromePid: identity.pid,
            chromeProcessIdentity: identity,
            profileDirectoryIdentity: profileDirectory,
            chromePort,
            chromeHost: "127.0.0.1",
            chromeProfileRoot: profileDir,
            userDataDir: profileDir,
            conversationId: "remote-conversation",
            promptEpoch: committedPromptEpoch(prompt),
            recoveryCleanup: {
              ownsTarget: false,
              profileKind: "temporary",
              keepBrowser: false,
            },
          },
        ],
        recoveryCleanupResult: { status: "failed", settlementMode: "abort" },
      };
      const seeded = await RemoteTransactionStore.open({
        directory: transactionStoreDir,
        controllerGeneration: "controller-before-restart",
      });
      await seedRemoteTransaction(seeded, transactionToken, {
        prompt,
        runtime,
        settlementMode: "abort",
      });
      await seeded.beginSettlementExecution({ transactionToken, mode: "abort" });
      await seeded.completeSettlement({
        transactionToken,
        mode: "abort",
        finalization: {
          status: "pending",
          runtime,
          error: "controller exited before launched Chrome cleanup completed",
        },
      });

      const exactChromeCleanup = vi.fn(
        async (_recordedRuntime: BrowserRunTransaction["runtime"], recordedProfileDir: string) => {
          const recordedProfileDirectory =
            await captureProfileDirectoryIdentity(recordedProfileDir);
          expect(sameProfileDirectoryIdentity(recordedProfileDirectory, profileDirectory)).toBe(
            true,
          );
          await expect(readOracleChromeOwner(recordedProfileDir)).resolves.toEqual({
            port: chromePort,
            processIdentity: identity,
            disposition: "close-on-last-lease",
          });
          return {
            status: "stopped" as const,
            pid: identity.pid,
            signal: "CONTROL_CHANNEL" as const,
          };
        },
      );
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          controllerGeneration: "controller-after-restart",
          exactChromeCleanup,
        },
      );
      try {
        const settlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/abort`,
          token: "secret",
          body: {},
        });
        expect(exactChromeCleanup, JSON.stringify(settlement.json)).toHaveBeenCalledOnce();
        expect(settlement, JSON.stringify(settlement.json)).toMatchObject({
          statusCode: 200,
          json: { state: "aborted" },
        });
        expect(exactChromeCleanup).toHaveBeenCalledWith(
          expect.objectContaining({ chromeProcessIdentity: identity }),
          expect.any(String),
          identity,
          expect.any(Function),
        );
        await expect(stat(profileDir)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(seeded.read(transactionToken)).resolves.toMatchObject({
          state: "aborted",
          terminalAudit: { settlementMode: "abort" },
        });
      } finally {
        await server.close();
        await rm(profileDir, { recursive: true, force: true });
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "serializes concurrent authenticated retries into one browser recovery",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-retry-single-flight-"));
      let transactionToken = "";
      const prompt = "single flight recovery";
      const runtime: BrowserRunTransaction["runtime"] = {
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch(prompt),
      };
      const recoveryStarted = Promise.withResolvers<void>();
      const releaseRecovery = Promise.withResolvers<void>();
      const resumeBrowser = vi.fn(async () => {
        recoveryStarted.resolve();
        await releaseRecovery.promise;
        return {
          answerText: "one answer",
          answerMarkdown: "one answer",
          runtime,
          bindSettlement: vi.fn(async () => runtime),
          finalize: vi.fn(async () => ({ status: "completed" as const, runtime })),
          abort: vi.fn(async () => ({ status: "completed" as const, runtime })),
        };
      });
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir: path.join(tmpDir, "transactions"),
          resumeBrowser,
          runBrowser: async () => {
            throw new BrowserAutomationError("Browser disconnected", {
              stage: "wait-for-answer",
              recoverableDisconnect: true,
              runtime,
            });
          },
        },
      );
      try {
        const caught = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        })({ prompt, config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toMatchObject({ details: { recoverableDisconnect: true } });
        transactionToken = remoteRecoveryTransactionToken(caught);

        const retryRequest = () =>
          httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: `/transactions/${transactionToken}/retry`,
            token: "secret",
            body: {},
          });
        const firstRetry = retryRequest();
        await recoveryStarted.promise;
        const secondRetry = retryRequest();
        releaseRecovery.resolve();
        const responses = await Promise.all([firstRetry, secondRetry]);
        expect(responses).toEqual([
          expect.objectContaining({
            statusCode: 200,
            json: expect.objectContaining({ status: "transaction" }),
          }),
          expect.objectContaining({
            statusCode: 200,
            json: expect.objectContaining({ status: "transaction" }),
          }),
        ]);
        expect(resumeBrowser).toHaveBeenCalledOnce();
      } finally {
        releaseRecovery.resolve();
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "serializes direct settlement against active browser work",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-settlement-gate-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const now = Date.now();
      const transactionStoreNow = () => now;
      const store = await openSeedTransactionStore(transactionStoreDir, 5_000, transactionStoreNow);
      const settlementToken = "e".repeat(64);
      const runToken = "f".repeat(64);
      const settlementRuntime = await seedRemoteTransaction(store, settlementToken, {
        prompt: "settlement waits for browser authority",
      });
      if (!settlementRuntime) throw new Error("missing seeded settlement runtime");
      const runStarted = Promise.withResolvers<void>();
      const releaseRun = Promise.withResolvers<void>();
      const retryCleanup = vi.fn(
        async (
          runtime: BrowserRunTransaction["runtime"],
          _logger: unknown,
          _deps: unknown,
          mode?: "finalize" | "abort",
        ) => {
          if (!mode) throw new Error("missing settlement mode");
          return { status: "completed" as const, runtime };
        },
      );
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          controllerGeneration: TEST_CONTROLLER_GENERATION,
          transactionLeaseDurationMs: 5_000,
          transactionStoreNow,
          leaseSweepIntervalMs: 1_000,
          retryCleanup,
          runBrowser: async (options) => {
            runStarted.resolve();
            await releaseRun.promise;
            return browserTransaction(options.prompt, {
              answerText: "active answer",
              answerMarkdown: "active answer",
              tookMs: 1,
              answerTokens: 2,
              answerChars: 13,
            });
          },
        },
      );
      try {
        const runRequest = httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${runToken}/run`,
          token: "secret",
          body: remoteRunPayload(),
        });
        await runStarted.promise;
        const busySettlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${settlementToken}/abort`,
          token: "secret",
          body: {},
        });
        expect(busySettlement).toMatchObject({ statusCode: 409, json: { error: "busy" } });
        expect(retryCleanup).not.toHaveBeenCalled();

        releaseRun.resolve();
        await expect(runRequest).resolves.toMatchObject({ statusCode: 200 });
        const settled = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${settlementToken}/abort`,
          token: "secret",
          body: {},
        });
        expect(settled).toMatchObject({ statusCode: 200, json: { state: "aborted" } });
        expect(retryCleanup).toHaveBeenCalledOnce();
        expect(retryCleanup.mock.calls[0]?.[3]).toBe("abort");
      } finally {
        releaseRun.resolve();
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "settles expired authority in abort or finalize mode and redacts pre-authority runs",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-expired-leases-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const leaseDurationMs = 20;
      let now = Date.now();
      const transactionStoreNow = () => now;
      const store = await openSeedTransactionStore(
        transactionStoreDir,
        leaseDurationMs,
        transactionStoreNow,
      );
      const abortToken = "7".repeat(64);
      const preAuthorityToken = "8".repeat(64);
      const finalizeToken = "9".repeat(64);
      await seedRemoteTransaction(store, abortToken, {
        prompt: "expired running authority",
        state: "running",
      });
      await seedRemoteTransaction(store, preAuthorityToken, {
        prompt: "expired before authority",
        state: "running",
        runtime: null,
      });
      await seedRemoteTransaction(store, finalizeToken, {
        prompt: "expired finalize cleanup",
        settlementMode: "finalize",
        publicationAcknowledged: true,
      });
      now += leaseDurationMs + 1;
      const cleanupModes: Array<"finalize" | "abort"> = [];
      const retryCleanup = vi.fn(
        async (
          runtime: BrowserRunTransaction["runtime"],
          _logger: unknown,
          _deps: unknown,
          mode?: "finalize" | "abort",
        ) => {
          if (!mode) throw new Error("missing settlement mode");
          cleanupModes.push(mode);
          return { status: "completed" as const, runtime };
        },
      );
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          controllerGeneration: TEST_CONTROLLER_GENERATION,
          transactionLeaseDurationMs: leaseDurationMs,
          transactionStoreNow,
          leaseSweepIntervalMs: 1_000,
          retryCleanup,
        },
      );
      try {
        expect(cleanupModes).toEqual(["abort", "finalize"]);
        expect(await store.read(abortToken)).toMatchObject({
          state: "aborted",
          terminalAudit: { settlementMode: "abort" },
        });
        const failed = await store.read(preAuthorityToken);
        expect(failed).toMatchObject({ state: "failed" });
        expect(failed).not.toHaveProperty("runtime");
        expect(failed).not.toHaveProperty("requestIdentity");
        expect(failed).not.toHaveProperty("browserConfig");
        expect(await store.read(finalizeToken)).toMatchObject({ state: "finalized" });

        const abortRetry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${abortToken}/retry`,
          token: "secret",
          body: {},
        });
        expect(abortRetry).toMatchObject({
          statusCode: 200,
          json: {
            status: "terminal",
            transactionToken: abortToken,
            outcome: { state: "aborted", finalization: { status: "completed" } },
          },
        });
        const finalizeRetry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${finalizeToken}/retry`,
          token: "secret",
          body: {},
        });
        expect(finalizeRetry).toMatchObject({
          statusCode: 200,
          json: {
            status: "terminal",
            transactionToken: finalizeToken,
            outcome: { state: "finalized", finalization: { status: "completed" } },
          },
        });
        const failedRetry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${preAuthorityToken}/retry`,
          token: "secret",
          body: {},
        });
        expect(failedRetry).toMatchObject({
          statusCode: 200,
          json: {
            status: "terminal",
            transactionToken: preAuthorityToken,
            outcome: { state: "failed", error: { recoverableDisconnect: false } },
          },
        });
        expect(JSON.stringify([abortRetry.json, finalizeRetry.json, failedRetry.json])).not.toMatch(
          /target-|requestIdentity|browserConfig|leaseExpiresAt/u,
        );
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "retains pending expired cleanup, retries it periodically, and clears the timer on close",
    async () => {
      vi.useFakeTimers();
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-pending-sweep-"));
      try {
        const transactionStoreDir = path.join(tmpDir, "transactions");
        const leaseDurationMs = 15;
        const transactionToken = "b".repeat(64);
        let now = Date.now();
        const transactionStoreNow = () => now;
        const store = await openSeedTransactionStore(
          transactionStoreDir,
          leaseDurationMs,
          transactionStoreNow,
        );
        await seedRemoteTransaction(store, transactionToken, {
          prompt: "pending cleanup retention",
          settlementMode: "abort",
        });
        now += leaseDurationMs + 1;
        const retryCleanup = vi.fn(
          async (
            runtime: BrowserRunTransaction["runtime"],
            _logger: unknown,
            _deps: unknown,
            mode?: "finalize" | "abort",
          ) => {
            if (!mode) throw new Error("missing settlement mode");
            return {
              status: "pending" as const,
              runtime: {
                ...runtime,
                recoveryCleanupResult: { status: "failed" as const, error: `${mode} pending` },
              },
              error: `${mode} pending`,
            };
          },
        );
        const server = await createRemoteServer(
          { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
          {
            transactionStoreDir,
            controllerGeneration: TEST_CONTROLLER_GENERATION,
            transactionLeaseDurationMs: leaseDurationMs,
            transactionStoreNow,
            leaseSweepIntervalMs: 5,
            retryCleanup,
          },
        );
        try {
          expect(retryCleanup).toHaveBeenCalledOnce();
          now += leaseDurationMs + 1;
          await vi.advanceTimersByTimeAsync(5);
          await vi.waitFor(() => {
            expect(retryCleanup.mock.calls.length).toBeGreaterThanOrEqual(2);
          });
          expect(retryCleanup.mock.calls.every((call) => call[3] === "abort")).toBe(true);
          expect(await store.read(transactionToken)).toMatchObject({
            state: "pending",
            settlementMode: "abort",
            finalization: { status: "pending" },
          });
          const retryResponse = await httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: `/transactions/${transactionToken}/retry`,
            token: "secret",
            body: {},
          });
          expect(retryResponse).toMatchObject({
            statusCode: 200,
            json: {
              status: "error",
              error: {
                code: "remote-settlement-pending",
                recoverableDisconnect: true,
                recoveryToken: transactionToken,
                settlementMode: "abort",
                runtime: { cleanup: { status: "pending" } },
              },
            },
          });
          expect(JSON.stringify(retryResponse.json)).not.toMatch(/target-|chromePort|chromeHost/u);

          await server.close();
          const attemptsAfterClose = retryCleanup.mock.calls.length;
          now += leaseDurationMs * 3;
          await vi.advanceTimersByTimeAsync(leaseDurationMs * 3);
          expect(retryCleanup).toHaveBeenCalledTimes(attemptsAfterClose);
        } finally {
          await server.close();
        }
      } finally {
        vi.useRealTimers();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "renews authenticated retry, artifact, receipt, and settlement requests only after auth",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-auth-renewal-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const transactionToken = "c".repeat(64);
      let now = Date.now();
      const transactionStoreNow = () => now;
      const store = await openSeedTransactionStore(transactionStoreDir, 5_000, transactionStoreNow);
      await seedRemoteTransaction(store, transactionToken, { prompt: "renew exact lease" });
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          controllerGeneration: TEST_CONTROLLER_GENERATION,
          transactionLeaseDurationMs: 5_000,
          transactionStoreNow,
          leaseSweepIntervalMs: 1_000,
        },
      );
      try {
        const initialLease = (await store.read(transactionToken))?.leaseExpiresAt;
        const unauthorizedRetry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/retry`,
          body: {},
        });
        expect(unauthorizedRetry.statusCode).toBe(401);
        expect((await store.read(transactionToken))?.leaseExpiresAt).toBe(initialLease);

        now += 10;
        const authenticatedRetry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/retry`,
          token: "secret",
          body: {},
        });
        expect(authenticatedRetry.statusCode).toBe(200);
        const retryLease = (await store.read(transactionToken))?.leaseExpiresAt;
        expect(Date.parse(retryLease ?? "")).toBeGreaterThan(Date.parse(initialLease ?? ""));

        const unauthorizedArtifact = await httpGetJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/artifacts/missing-artifact`,
        });
        expect(unauthorizedArtifact.statusCode).toBe(401);
        expect((await store.read(transactionToken))?.leaseExpiresAt).toBe(retryLease);

        now += 10;
        const authenticatedArtifact = await httpGetJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/artifacts/missing-artifact`,
          token: "secret",
        });
        expect(authenticatedArtifact.statusCode).toBe(404);
        const artifactLease = (await store.read(transactionToken))?.leaseExpiresAt;
        expect(Date.parse(artifactLease ?? "")).toBeGreaterThan(Date.parse(retryLease ?? ""));

        const unauthorizedReceipt = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/artifacts/missing-artifact/receipt`,
          body: { sha256: "d".repeat(64), byteSize: 1 },
        });
        expect(unauthorizedReceipt.statusCode).toBe(401);
        expect((await store.read(transactionToken))?.leaseExpiresAt).toBe(artifactLease);

        now += 10;
        const receipt = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/artifacts/missing-artifact/receipt`,
          token: "secret",
          body: { sha256: "d".repeat(64), byteSize: 1 },
        });
        expect(receipt.statusCode).toBe(404);
        const receiptLease = (await store.read(transactionToken))?.leaseExpiresAt;
        expect(Date.parse(receiptLease ?? "")).toBeGreaterThan(Date.parse(artifactLease ?? ""));

        const unauthorizedSettlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/finalize`,
          body: {},
        });
        expect(unauthorizedSettlement.statusCode).toBe(401);
        expect((await store.read(transactionToken))?.leaseExpiresAt).toBe(receiptLease);

        now += 10;
        const invalidSettlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/finalize`,
          token: "secret",
          body: {},
        });
        expect(invalidSettlement.statusCode).toBe(400);
        const settlementLease = (await store.read(transactionToken))?.leaseExpiresAt;
        expect(Date.parse(settlementLease ?? "")).toBeGreaterThan(Date.parse(receiptLease ?? ""));
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "holds one crash-recoverable controller lock per durable transaction store",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-controller-lock-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const options = { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} };
      const first = await createRemoteServer(options, { transactionStoreDir });
      try {
        await expect(createRemoteServer(options, { transactionStoreDir })).rejects.toThrow(
          /lock|owner|active/i,
        );
      } finally {
        await first.close();
      }
      const restarted = await createRemoteServer(options, { transactionStoreDir });
      await restarted.close();
      await rm(tmpDir, { recursive: true, force: true });
    },
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "falls back to the staged exact capture when the initial publication write fails",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-staged-publish-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const runtime: BrowserRunTransaction["runtime"] = {
        chromeTargetId: "staged-publication-target",
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch("remote test"),
        recoveryCleanupResources: [
          {
            chromeTargetId: "staged-publication-target",
            conversationId: "remote-conversation",
            promptEpoch: committedPromptEpoch("remote test"),
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const publishCapture = vi
        .spyOn(RemoteTransactionStore.prototype, "publishCapture")
        .mockRejectedValueOnce(new Error("simulated initial publication write failure"));
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) => {
            const result: BrowserRunResult = {
              answerText: "staged exact answer",
              answerMarkdown: "staged exact answer",
              tookMs: 2,
              answerTokens: 3,
              answerChars: 19,
            };
            const transaction = browserTransaction(options.prompt, result, runtime);
            await options.preArchiveCaptureCb?.(result, transaction.runtime);
            return transaction;
          },
        },
      );
      try {
        const response = await httpPostNdjson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${"1".repeat(64)}/run`,
          token: "secret",
          body: remoteRunPayload(),
        });
        expect(response.events).toContainEqual(
          expect.objectContaining({
            type: "transaction",
            transaction: expect.objectContaining({
              result: expect.objectContaining({
                answerText: "staged exact answer",
                warnings: expect.arrayContaining([
                  expect.objectContaining({ code: "remote-publication-write-recovered" }),
                ]),
              }),
            }),
          }),
        );
        const record = await RemoteTransactionStore.open({
          directory: transactionStoreDir,
          controllerGeneration: "staged-publication-reader",
        });
        const published = await record.read("1".repeat(64));
        expect(published).toMatchObject({
          state: "pending",
          result: { answerText: "staged exact answer" },
        });
        expect(published).not.toHaveProperty("stagedCapture");
        expect(publishCapture).toHaveBeenCalledOnce();
      } finally {
        publishCapture.mockRestore();
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "promotes the durable pre-archive capture after restart without browser recapture",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-staged-restart-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const transactionToken = "2".repeat(64);
      const prompt = "restart after archive";
      const runtime: BrowserRunTransaction["runtime"] = {
        browserTransport: "cdp",
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeTargetId: "lost-after-archive",
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch(prompt),
        recoveryCleanupResources: [
          {
            chromeHost: "127.0.0.1",
            chromePort: 9222,
            chromeTargetId: "lost-after-archive",
            conversationId: "remote-conversation",
            promptEpoch: committedPromptEpoch(prompt),
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "none",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const beforeCrash = await RemoteTransactionStore.open({
        directory: transactionStoreDir,
        controllerGeneration: "controller-before-staged-crash",
      });
      await beforeCrash.begin({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        transactionToken,
        runId: "run-staged-crash",
        createdAt: new Date().toISOString(),
        requestIdentity: {
          acceptedPromptSha256: [promptIdentitySha256(prompt)],
          followUpOrdinal: 0,
          remainingFollowUps: 0,
        },
        browserConfig: { chatgptUrl: "https://chatgpt.com/" },
      });
      await beforeCrash.stageCapture({
        transactionToken,
        runId: "run-staged-crash",
        result: {
          answerText: "restart-safe staged answer",
          answerMarkdown: "restart-safe staged answer",
          tookMs: 3,
          answerTokens: 4,
          answerChars: 26,
        },
        runtime,
      });
      const resumeBrowser = vi.fn(async () => {
        throw new Error("retry must not recapture a durable staged answer");
      });
      const restarted = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          controllerGeneration: "controller-after-staged-crash",
          resumeBrowser,
        },
      );
      try {
        const retry = await httpPostJson({
          hostname: "127.0.0.1",
          port: restarted.port,
          path: `/transactions/${transactionToken}/retry`,
          token: "secret",
          body: {},
        });
        expect(retry).toMatchObject({
          statusCode: 200,
          json: {
            status: "transaction",
            transaction: {
              result: {
                answerText: "restart-safe staged answer",
                warnings: [
                  expect.objectContaining({ code: "remote-post-archive-target-unavailable" }),
                ],
              },
            },
          },
        });
        expect(resumeBrowser).not.toHaveBeenCalled();
        const afterRetry = await RemoteTransactionStore.open({
          directory: transactionStoreDir,
          controllerGeneration: "staged-retry-reader",
        });
        const record = await afterRetry.read(transactionToken);
        expect(record).toMatchObject({
          state: "pending",
          result: { answerText: "restart-safe staged answer" },
          runtime: {
            conversationId: "remote-conversation",
            promptEpoch: committedPromptEpoch(prompt),
          },
        });
        expect(record).not.toHaveProperty("stagedCapture");
        expect(JSON.stringify(record?.runtime)).not.toMatch(
          /lost-after-archive|chromeTargetId|chromePort|chromeHost|recoveryCleanupResources/u,
        );
      } finally {
        await restarted.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "invalidates and aborts a staged capture on positive post-archive identity mismatch",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-staged-mismatch-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const transactionToken = "3".repeat(64);
      const runtime: BrowserRunTransaction["runtime"] = {
        chromeTargetId: "mismatched-post-archive-target",
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch("remote test"),
        recoveryCleanupResources: [
          {
            chromeTargetId: "mismatched-post-archive-target",
            conversationId: "remote-conversation",
            promptEpoch: committedPromptEpoch("remote test"),
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const retryCleanup = vi.fn<typeof retryBrowserRecoveryCleanup>(async (cleanupRuntime) => ({
        status: "completed" as const,
        runtime: cleanupRuntime,
      }));
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          retryCleanup,
          runBrowser: async (options) => {
            const result: BrowserRunResult = {
              answerText: "must never publish",
              answerMarkdown: "must never publish",
              tookMs: 1,
              answerTokens: 3,
              answerChars: 18,
            };
            const transaction = browserTransaction(options.prompt, result, runtime);
            await options.preArchiveCaptureCb?.(result, transaction.runtime);
            throw new BrowserAutomationError("Post-archive prompt identity changed", {
              stage: "prompt-epoch",
              code: "committed-prompt-identity-mismatch",
            });
          },
        },
      );
      try {
        const run = await httpPostNdjson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/run`,
          token: "secret",
          body: remoteRunPayload(),
        });
        expect(run.events.some((event) => event.type === "transaction")).toBe(false);
        expect(retryCleanup).toHaveBeenCalledOnce();
        expect(retryCleanup.mock.calls[0]?.[3]).toBe("abort");
        const retry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/retry`,
          token: "secret",
          body: {},
        });
        expect(retry).toMatchObject({
          statusCode: 200,
          json: { status: "terminal", outcome: { state: "aborted" } },
        });
        const recordPath = path.join(transactionStoreDir, `${transactionToken}.json`);
        const record = JSON.parse(await readFile(recordPath, "utf8"));
        expect(record).toMatchObject({
          state: "aborted",
          terminalAudit: { settlementMode: "abort" },
        });
        expect(record).not.toHaveProperty("result");
        expect(record).not.toHaveProperty("stagedCapture");
        expect(record).not.toHaveProperty("runtime");
        expect(record).not.toHaveProperty("requestIdentity");
        expect(record).not.toHaveProperty("browserConfig");
        expect(JSON.stringify(record)).not.toMatch(
          /must never publish|mismatched-post-archive-target/u,
        );
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
});

function createArtifactDescriptor(
  payload: Buffer,
  overrides: Partial<RemoteArtifactDescriptor> = {},
): RemoteArtifactDescriptor {
  return {
    artifactId: "artifact-id",
    runId: "run-id",
    kind: "file",
    filename: "result.zip",
    mimeType: "application/zip",
    byteSize: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"),
    sourceUrlKind: "sandbox",
    transferStatus: "ready",
    ...overrides,
    required: overrides.required ?? true,
  };
}

function createAuthenticatedTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
): http.Server {
  const rootKey = "secret";
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

async function prepareTestAuthentication({
  hostname,
  port,
  path,
  token,
  method,
  body,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  method: string;
  body: Buffer;
}): Promise<{ rootKey: string; authentication: RemoteAuthenticatedRequest } | null> {
  const rootKey = token?.trim();
  if (!rootKey) return null;
  const host = hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`;
  const health = await checkRemoteHealth({ host, token: rootKey });
  if (!health.ok || health.protocol !== "transaction-v3" || !health.serverGeneration) {
    throw new Error(`test remote generation proof failed: ${health.error ?? "unavailable"}`);
  }
  return {
    rootKey,
    authentication: createRemoteAuthenticatedRequest({
      rootKey,
      serverGeneration: health.serverGeneration,
      method,
      path,
      body,
    }),
  };
}

function sendTestRequestBody({
  req,
  authentication,
  method,
  path,
  body,
}: {
  req: http.ClientRequest;
  authentication: { rootKey: string; authentication: RemoteAuthenticatedRequest } | null;
  method: string;
  path: string;
  body: Buffer;
}): void {
  if (!authentication) {
    req.end(body);
    return;
  }
  let proofVerified = false;
  let continueReceived = false;
  let bodySent = false;
  const send = () => {
    if (bodySent || !proofVerified || !continueReceived) return;
    bodySent = true;
    req.end(body);
  };
  req.on("information", (information) => {
    if (information.statusCode !== 103) return;
    const proof = String(information.headers[REMOTE_REQUEST_PROOF_HEADER] ?? "");
    if (
      !verifyRemoteRequestProof({
        rootKey: authentication.rootKey,
        method,
        path,
        authentication: authentication.authentication,
        proof,
      })
    ) {
      req.destroy(new Error("test remote returned an invalid request proof"));
      return;
    }
    proofVerified = true;
    send();
  });
  req.on("continue", () => {
    continueReceived = true;
    send();
  });
  req.flushHeaders();
}

async function httpGetJson({
  hostname,
  port,
  path,
  token,
  headers,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  headers?: Record<string, string>;
}): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  if (path === "/health" && token?.trim()) {
    const host = hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`;
    const health = await checkRemoteHealth({ host, token });
    return {
      statusCode: health.statusCode ?? 0,
      json: {
        ok: health.ok,
        ...(health.version ? { version: health.version } : {}),
        ...(health.uptimeSeconds !== undefined ? { uptimeSeconds: health.uptimeSeconds } : {}),
        ...(health.capabilities ? { capabilities: health.capabilities } : {}),
        ...(health.error ? { error: health.error } : {}),
      },
    };
  }
  const authentication = await prepareTestAuthentication({
    hostname,
    port,
    path,
    token,
    method: "GET",
    body: Buffer.alloc(0),
  });
  const deferred = Promise.withResolvers<{
    statusCode: number;
    json: Record<string, unknown> | null;
  }>();
  const req = http.request(
    {
      hostname,
      port,
      path,
      method: "GET",
      headers: {
        ...(headers ?? {}),
        ...(authentication ? authentication.authentication.headers : {}),
      },
    },
    (res) => {
      readIncomingBody(res)
        .then((body) => {
          const statusCode = res.statusCode ?? 0;
          let json: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = body.length ? JSON.parse(body) : null;
            json =
              parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          deferred.resolve({ statusCode, json });
        })
        .catch(deferred.reject);
    },
  );
  req.on("error", deferred.reject);
  req.end();
  return await deferred.promise;
}

async function httpPostJson({
  hostname,
  port,
  path,
  token,
  body,
  headers,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  body: unknown;
  headers?: Record<string, string>;
}): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  const serialized = Buffer.from(JSON.stringify(body));
  const authentication = await prepareTestAuthentication({
    hostname,
    port,
    path,
    token,
    method: "POST",
    body: serialized,
  });
  const deferred = Promise.withResolvers<{
    statusCode: number;
    json: Record<string, unknown> | null;
  }>();
  const req = http.request(
    {
      hostname,
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": serialized.byteLength,
        ...(headers ?? {}),
        ...(authentication
          ? { Expect: "100-continue", ...authentication.authentication.headers }
          : {}),
      },
    },
    (res) => {
      readIncomingBody(res)
        .then((responseBody) => {
          let json: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = responseBody ? JSON.parse(responseBody) : null;
            json =
              parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          deferred.resolve({ statusCode: res.statusCode ?? 0, json });
        })
        .catch(deferred.reject);
    },
  );
  req.on("error", deferred.reject);
  sendTestRequestBody({ req, authentication, method: "POST", path, body: serialized });
  return await deferred.promise;
}

async function httpPostNdjson({
  hostname,
  port,
  path,
  token,
  body,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  body: unknown;
}): Promise<{ statusCode: number; events: Array<Record<string, unknown>> }> {
  const serialized = Buffer.from(JSON.stringify(body));
  const authentication = await prepareTestAuthentication({
    hostname,
    port,
    path,
    token,
    method: "POST",
    body: serialized,
  });
  const deferred = Promise.withResolvers<{
    statusCode: number;
    events: Array<Record<string, unknown>>;
  }>();
  const req = http.request(
    {
      hostname,
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": serialized.byteLength,
        ...(authentication
          ? { Expect: "100-continue", ...authentication.authentication.headers }
          : {}),
      },
    },
    (res) => {
      readIncomingBody(res)
        .then((responseBody) => {
          const events = responseBody
            .split(/\r?\n/u)
            .filter(Boolean)
            .map((line) => {
              const parsed: unknown = JSON.parse(line);
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("Remote NDJSON event is not an object");
              }
              return parsed as Record<string, unknown>;
            });
          deferred.resolve({ statusCode: res.statusCode ?? 0, events });
        })
        .catch(deferred.reject);
    },
  );
  req.on("error", deferred.reject);
  sendTestRequestBody({ req, authentication, method: "POST", path, body: serialized });
  return await deferred.promise;
}

async function postJsonAndDisconnect({
  hostname,
  port,
  path,
  token,
  body,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  body: unknown;
}): Promise<void> {
  const serialized = Buffer.from(JSON.stringify(body));
  const authentication = await prepareTestAuthentication({
    hostname,
    port,
    path,
    token,
    method: "POST",
    body: serialized,
  });
  const deferred = Promise.withResolvers<void>();
  const req = http.request(
    {
      hostname,
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": serialized.byteLength,
        ...(authentication
          ? { Expect: "100-continue", ...authentication.authentication.headers }
          : {}),
      },
    },
    (res) => {
      res.destroy();
      deferred.resolve();
    },
  );
  req.on("error", deferred.reject);
  sendTestRequestBody({ req, authentication, method: "POST", path, body: serialized });
  await deferred.promise;
}

function remoteRunPayload(): RemoteRunPayload {
  return {
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    prompt: "remote test",
    attachments: [],
    browserConfig: {},
    options: {},
  };
}

const TEST_CONTROLLER_GENERATION = "server-test-controller";

async function openSeedTransactionStore(
  directory: string,
  leaseDurationMs: number,
  now: () => number,
) {
  return await RemoteTransactionStore.open({
    directory,
    controllerGeneration: TEST_CONTROLLER_GENERATION,
    leaseDurationMs,
    now,
  });
}

async function seedRemoteTransaction(
  store: RemoteTransactionStore,
  transactionToken: string,
  options: {
    prompt: string;
    state?: "running" | "pending" | "recoverable-error";
    runtime?: BrowserRunTransaction["runtime"] | null;
    settlementMode?: "finalize" | "abort";
    publicationAcknowledged?: boolean;
  },
) {
  const state = options.state ?? "pending";
  const runtime =
    options.runtime === null
      ? undefined
      : (options.runtime ?? {
          conversationId: "remote-conversation",
          promptEpoch: committedPromptEpoch(options.prompt),
          recoveryCleanupResources: [
            {
              chromeTargetId: `target-${transactionToken.slice(0, 8)}`,
              conversationId: "remote-conversation",
              promptEpoch: committedPromptEpoch(options.prompt),
              recoveryCleanup: {
                ownsTarget: true,
                profileKind: "temporary" as const,
                keepBrowser: false,
                closeOwnedTargetOnComplete: true,
              },
            },
          ],
        });
  const runId = `run-${transactionToken.slice(0, 8)}`;
  await store.begin({
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    transactionToken,
    runId,
    createdAt: new Date().toISOString(),
    requestIdentity: {
      acceptedPromptSha256: [promptIdentitySha256(options.prompt)],
      followUpOrdinal: 0,
      remainingFollowUps: 0,
    },
    browserConfig: {
      chatgptUrl: "https://chatgpt.com",
      url: "https://chatgpt.com",
      remoteChrome: null,
      attachRunning: false,
    },
  });
  if (state === "running") {
    if (runtime) await store.journalRuntime(transactionToken, runtime);
  } else if (state === "recoverable-error") {
    if (!runtime) throw new Error("recoverable seed requires runtime authority");
    await store.recordRecoverableFailure({
      transactionToken,
      runtime,
      error: {
        name: "BrowserAutomationError",
        category: "browser-automation",
        message: "seeded recoverable browser disconnect",
        stage: "remote-controller-restart",
        recoverableDisconnect: true,
      },
    });
  } else {
    if (!runtime) throw new Error("pending seed requires runtime authority");
    await store.publishCapture({
      transactionToken,
      runId,
      runtime,
      result: {
        answerText: "durable answer",
        answerMarkdown: "durable answer",
        tookMs: 1,
        answerTokens: 2,
        answerChars: 14,
      },
    });
  }
  if (options.settlementMode) {
    await store.bindSettlement({
      transactionToken,
      mode: options.settlementMode,
      durablePublication: options.publicationAcknowledged === true,
    });
  }
  return runtime;
}

function remoteRecoveryTransactionToken(error: unknown): string {
  if (!(error instanceof BrowserAutomationError)) {
    throw new Error("Expected recoverable BrowserAutomationError");
  }
  const runtime = error.details?.runtime as BrowserRunTransaction["runtime"] | undefined;
  const transactionToken = runtime?.recoveryCleanupResources?.find(
    (resource) => resource.remoteRecovery,
  )?.remoteRecovery?.transactionToken;
  if (typeof transactionToken !== "string" || !/^[a-f0-9]{64}$/u.test(transactionToken)) {
    throw new Error("Recoverable error is missing exact remote transaction authority");
  }
  return transactionToken;
}

async function readIncomingBody(
  stream: NodeJS.ReadableStream & AsyncIterable<Buffer | string>,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
