import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import {
  createRemoteServer,
  __test__ as serverTest,
  type RemoteServerInstance,
} from "../../src/remote/server.js";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";
import type { BrowserLogger, BrowserRunTransaction } from "../../src/browser/types.js";
import type { BrowserRunResult } from "../../src/browserMode.js";
import { writeBinaryBrowserArtifact } from "../../src/browser/artifacts.js";
import {
  MAX_REMOTE_ARTIFACT_BYTES,
  MAX_REMOTE_ATTACHMENT_BYTES,
  MAX_REMOTE_ATTACHMENTS,
  MAX_REMOTE_PROMPT_CHARS,
  MAX_REMOTE_REQUEST_BYTES,
  MAX_REMOTE_TOTAL_ATTACHMENT_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
} from "../../src/remote/types.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import {
  CAN_LISTEN_LOCALHOST,
  browserTransaction,
  remoteRunPayload,
} from "./serverTestBuilders.js";
import { httpGetJson, httpPostJson } from "./serverTestHttp.js";

describe("remote browser service", { timeout: 15_000 }, () => {
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
            expect(options.artifactWriteAuthority?.artifactsDirectory).not.toContain(
              "remote-session-id",
            );
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
        artifactNamespace: expect.stringMatching(/^remote-[a-f0-9]{64}$/),
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
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "isolates concurrent same-session artifact writes by exact transaction namespace",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-authority-"));
      setOracleHomeDirOverrideForTest(root);
      let server: RemoteServerInstance | null = null;
      const bothStarted = Promise.withResolvers<void>();
      const hostArtifacts: Array<{ prompt: string; path: string; contents: Buffer }> = [];
      const observedSessions: string[] = [];
      const observedAuthorities: string[] = [];

      try {
        server = await createRemoteServer(
          { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
          {
            transactionStoreDir: path.join(root, "transactions"),
            runBrowser: async (options) => {
              observedSessions.push(options.sessionId ?? "");
              const artifactWriteAuthority = options.artifactWriteAuthority;
              if (!artifactWriteAuthority) {
                throw new Error("Missing exact server artifact write authority");
              }
              observedAuthorities.push(artifactWriteAuthority.artifactsDirectory);
              if (observedAuthorities.length === 2) bothStarted.resolve();
              await bothStarted.promise;
              const contents = Buffer.from(`bytes:${options.prompt}`, "utf8");
              const artifact = await writeBinaryBrowserArtifact({
                sessionId: options.sessionId,
                artifactWriteAuthority,
                kind: "file",
                filename: "shared-result.txt",
                contents,
                mimeType: "text/plain",
                sourceUrl: "browser-download",
              });
              if (!artifact) throw new Error("Expected host artifact");
              hostArtifacts.push({ prompt: options.prompt, path: artifact.path, contents });
              return browserTransaction(options.prompt, {
                answerText: options.prompt,
                answerMarkdown: options.prompt,
                tookMs: 1,
                answerTokens: 1,
                answerChars: options.prompt.length,
                savedFiles: [
                  {
                    ...artifact,
                    kind: "file",
                    url: "browser-download",
                    finalUrl: "browser-download",
                    filename: path.basename(artifact.path),
                  },
                ],
              });
            },
          },
        );
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        });
        const [first, second] = await Promise.all(
          ["first", "second"].map((prompt) =>
            executor({ prompt, config: {}, sessionId: "shared-client-session" }),
          ),
        );

        expect(observedSessions).toEqual(["shared-client-session", "shared-client-session"]);
        expect(new Set(observedAuthorities).size).toBe(2);
        expect(hostArtifacts).toHaveLength(2);
        await Promise.all(
          hostArtifacts.map(async (artifact) => {
            expect(path.dirname(artifact.path)).toBe(
              observedAuthorities.find((directory) => directory === path.dirname(artifact.path)),
            );
            await expect(readFile(artifact.path)).resolves.toEqual(artifact.contents);
          }),
        );
        const records = await Promise.all(
          (await readdir(path.join(root, "transactions")))
            .filter((name) => name.endsWith(".json"))
            .map((name) => readFile(path.join(root, "transactions", name), "utf8")),
        );
        expect(new Set(records.map((raw) => JSON.parse(raw).artifactNamespace)).size).toBe(2);
        await Promise.all([first.finalize(), second.finalize()]);
      } finally {
        await server?.close().catch(() => undefined);
        setOracleHomeDirOverrideForTest(null);
        await rm(root, { recursive: true, force: true });
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
      { ownerPolicy: "service-persistent" },
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
});
