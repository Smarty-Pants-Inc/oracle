import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
  readFile,
  stat,
} from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import type { RemoteServerInstance } from "../../src/remote/server.js";
import { bootstrapRemoteManualChromeOwner } from "../../src/remote/serverLifecycle.js";
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
import { __test__ as serverExecutionTest } from "../../src/remote/serverExecution.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import {
  CAN_LISTEN_LOCALHOST,
  browserTransaction,
  createTestRemoteServer,
  createTestRemoteBrowserTransactionExecutor as createRemoteBrowserTransactionExecutor,
  remoteRunPayload,
} from "./serverTestBuilders.js";
import { httpGetJson, httpPostJson } from "./serverTestHttp.js";
import { readAuthenticatedTransactionRecord } from "./serverTestTransactions.js";
import { testWindowsPrivateDirectoryAuthority } from "../privateAuthorityTestHelpers.js";

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
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          runBrowser: async (options) => {
            runLog.push(options.prompt);
            expect(options.sessionId).toMatch(/^[0-9a-f]{64}$/u);
            expect(options.sessionId).not.toBe("remote-session-id");
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
            options.log?.(`uploading attachment ${attachment.path}`);
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

      const executor = createRemoteBrowserTransactionExecutor({
        host: `127.0.0.1:${server.port}`,
        token: "a".repeat(64),
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
      expect(clientLogs.join("\n")).not.toContain("oracle-serve-");
      expect(clientLogs.join("\n")).toContain("[host-path]");
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
      const pendingRecord = await readAuthenticatedTransactionRecord(
        transactionStoreDir,
        recordName.slice(0, -".json".length),
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
      const finalizedRecord = await readAuthenticatedTransactionRecord(
        transactionStoreDir,
        recordName.slice(0, -".json".length),
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
        token: "a".repeat(64),
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
        token: "a".repeat(64),
      });
      expect(malformedArtifactPath.statusCode).toBe(404);

      const healthAfterMalformedPath = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/health",
        token: "a".repeat(64),
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
      const transactionStoreDir = path.join(root, "transactions");
      setOracleHomeDirOverrideForTest(root);
      let server: RemoteServerInstance | null = null;
      const bothStarted = Promise.withResolvers<void>();
      const hostArtifacts: Array<{ prompt: string; path: string; contents: Buffer }> = [];
      const observedSessions: string[] = [];
      const observedAuthorities: string[] = [];

      try {
        server = await createTestRemoteServer(
          { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
          {
            transactionStoreDir,
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
        const executor = createRemoteBrowserTransactionExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "a".repeat(64),
        });
        const [first, second] = await Promise.all(
          ["first", "second"].map((prompt) =>
            executor({ prompt, config: {}, sessionId: "shared-client-session" }),
          ),
        );

        expect(observedSessions).toHaveLength(2);
        expect(new Set(observedSessions).size).toBe(2);
        expect(observedSessions.every((ownerId) => /^[0-9a-f]{64}$/u.test(ownerId))).toBe(true);
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
          (await readdir(transactionStoreDir))
            .filter((name) => name.endsWith(".json"))
            .map((name) =>
              readAuthenticatedTransactionRecord(
                transactionStoreDir,
                name.slice(0, -".json".length),
              ),
            ),
        );
        expect(new Set(records.map((record) => record.artifactNamespace)).size).toBe(2);
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
      const server = await createTestRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "a".repeat(64),
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
        const executor = createRemoteBrowserTransactionExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "a".repeat(64),
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

    await bootstrapRemoteManualChromeOwner("/tmp/oracle-serve-bootstrap", logger, {
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
      bootstrapRemoteManualChromeOwner(
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
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        { runBrowser, transactionStoreDir: path.join(tmpDir, "transactions") },
      );

      try {
        const authorityResponse = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${"1".repeat(64)}/run`,
          token: "a".repeat(64),
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
          token: "a".repeat(64),
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
  test("rejects precreated scratch symlinks and directories", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-scratch-entry-"));
    const target = path.join(directory, "target.txt");
    const attachment = {
      fileName: "note.txt",
      displayPath: "note.txt",
      sizeBytes: 5,
      contentBase64: Buffer.from("hello").toString("base64"),
    };
    try {
      await writeFile(target, "target");
      await symlink(target, path.join(directory, "1-note.txt"));
      await expect(
        serverExecutionTest.materializeRemoteAttachments([attachment], directory, "attachment"),
      ).rejects.toThrow("Remote attachment scratch materialization failed");
      await rm(path.join(directory, "1-note.txt"));
      await mkdir(path.join(directory, "1-note.txt"));
      await expect(
        serverExecutionTest.materializeRemoteAttachments([attachment], directory, "attachment"),
      ).rejects.toThrow("Remote attachment scratch materialization failed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "cleans partial remote scratch attachments after the second sync fails",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-scratch-partial-"));
      const scratchRoot = path.join(root, "oracle-private");
      const transactionStoreDir = path.join(root, "transactions");
      const actualFs = await vi.importActual<typeof FsPromises>("node:fs/promises");
      let scratchSyncs = 0;
      let server: RemoteServerInstance | null = null;

      vi.resetModules();
      vi.doMock("node:fs/promises", () => ({
        ...actualFs,
        open: async (...args: Parameters<typeof actualFs.open>) => {
          const handle = await actualFs.open(...args);
          if (
            typeof args[0] !== "string" ||
            !["1-first.txt", "2-second.txt"].includes(path.basename(args[0]))
          ) {
            return handle;
          }
          return new Proxy(handle, {
            get(target, property) {
              if (property === "sync") {
                return async () => {
                  scratchSyncs += 1;
                  if (scratchSyncs === 2)
                    throw new Error("simulated second attachment sync failure");
                  return await target.sync();
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      }));
      // Reload after the fs mock because ESM captures the production bindings at import time.
      const { createTestRemoteServer: createIsolatedTestRemoteServer } =
        await import("./serverTestBuilders.js");
      const { setOracleHomeDirOverrideForTest: setIsolatedOracleHome } =
        await import("../../src/oracleHome.js");
      try {
        await mkdir(scratchRoot, { mode: 0o700 });
        const scratchSnapshot = await readdir(scratchRoot);
        setIsolatedOracleHome(root);
        const runBrowser = vi.fn(async () => {
          throw new Error("partial scratch attachment must not reach browser execution");
        });
        server = await createIsolatedTestRemoteServer(
          { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
          { transactionStoreDir, runBrowser },
        );

        const response = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${"b".repeat(64)}/run`,
          token: "a".repeat(64),
          body: {
            ...remoteRunPayload(),
            attachments: [
              {
                fileName: "first.txt",
                displayPath: "first.txt",
                sizeBytes: 5,
                contentBase64: Buffer.from("first").toString("base64"),
              },
              {
                fileName: "second.txt",
                displayPath: "second.txt",
                sizeBytes: 6,
                contentBase64: Buffer.from("second").toString("base64"),
              },
            ],
          },
        });

        expect(response.statusCode).toBe(200);
        expect(scratchSyncs).toBe(2);
        expect(runBrowser).not.toHaveBeenCalled();
        const scratchAfter = await readdir(scratchRoot);
        expect(scratchAfter).toEqual(scratchSnapshot);
        expect(scratchAfter).toEqual([]);
      } finally {
        await server?.close().catch(() => undefined);
        setIsolatedOracleHome(null);
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  test("fails before scratch descendants when Windows private authority is unavailable", async () => {
    const ambient = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-hostile-temp-"));
    const establishWindowsPrivateDirectory = vi.fn(async () => {
      throw new Error("simulated Windows private root failure");
    });
    try {
      await expect(
        serverExecutionTest.createRemoteScratchRun("run-", {
          platform: "win32",
          tempDirectory: ambient,
          windowsPrivateDirectoryAuthority: establishWindowsPrivateDirectory,
        }),
      ).rejects.toThrow("simulated Windows private root failure");
      expect(establishWindowsPrivateDirectory).toHaveBeenCalledOnce();
      expect(await readdir(ambient)).toEqual([]);
    } finally {
      await rm(ambient, { recursive: true, force: true });
    }
  });

  test("rejects replaced remote scratch attachments", async () => {
    const ambient = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-scratch-file-"));
    const run = await serverExecutionTest.createRemoteScratchRun("run-", {
      tempDirectory: ambient,
      windowsPrivateDirectoryAuthority: testWindowsPrivateDirectoryAuthority,
    });
    const generation = await serverExecutionTest.createRemoteScratchGeneration(run, "attachments-");
    const attachment = {
      fileName: "note.txt",
      displayPath: "note.txt",
      sizeBytes: 5,
      contentBase64: Buffer.from("hello").toString("base64"),
    };
    try {
      const materialized = await serverExecutionTest.materializeRemoteAttachments(
        [attachment],
        generation.path,
        "attachment",
      );
      const file = materialized.files[0];
      if (!file) throw new Error("missing scratch file");
      if (process.platform !== "win32") {
        expect((await stat(run.parent.path)).mode & 0o777).toBe(0o700);
        expect((await stat(run.path)).mode & 0o777).toBe(0o700);
        expect((await stat(generation.path)).mode & 0o777).toBe(0o700);
        expect((await stat(file.path)).mode & 0o777).toBe(0o600);
      }
      await rm(file.path);
      await writeFile(file.path, "other", { mode: 0o600 });
      await expect(
        serverExecutionTest.assertRemoteScratchFiles(materialized.files),
      ).rejects.toThrow("Remote attachment scratch file changed");
    } finally {
      await rm(ambient, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "rejects hard-linked remote scratch attachments",
    async () => {
      const ambient = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-scratch-link-"));
      const run = await serverExecutionTest.createRemoteScratchRun("run-", {
        tempDirectory: ambient,
      });
      const generation = await serverExecutionTest.createRemoteScratchGeneration(
        run,
        "attachments-",
      );
      const attachment = {
        fileName: "note.txt",
        displayPath: "note.txt",
        sizeBytes: 5,
        contentBase64: Buffer.from("hello").toString("base64"),
      };
      try {
        const materialized = await serverExecutionTest.materializeRemoteAttachments(
          [attachment],
          generation.path,
          "attachment",
        );
        const file = materialized.files[0];
        if (!file) throw new Error("missing scratch file");
        await link(file.path, path.join(generation.path, "alias.txt"));
        await expect(
          serverExecutionTest.assertRemoteScratchFiles(materialized.files),
        ).rejects.toThrow("Remote attachment scratch file changed");
      } finally {
        await rm(ambient, { recursive: true, force: true });
      }
    },
  );

  test("retains a scratch generation substituted after its tracked file is unlinked", async () => {
    const ambient = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-scratch-cleanup-"));
    const actualFs = await vi.importActual<typeof FsPromises>("node:fs/promises");
    let replacementPath: string | undefined;

    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      unlink: async (...args: Parameters<typeof actualFs.unlink>) => {
        await actualFs.unlink(...args);
        const trackedFile = String(args[0]);
        if (path.basename(trackedFile) !== "1-note.txt" || replacementPath) return;
        const generationPath = path.dirname(trackedFile);
        await actualFs.rename(generationPath, `${generationPath}-displaced`);
        await actualFs.mkdir(generationPath, { mode: 0o700 });
        replacementPath = generationPath;
      },
    }));
    // Reload after the fs mock because ESM captures the production bindings at import time.
    const { __test__: isolatedServerExecutionTest } =
      await import("../../src/remote/serverExecution.js");
    try {
      const run = await isolatedServerExecutionTest.createRemoteScratchRun("run-", {
        tempDirectory: ambient,
        windowsPrivateDirectoryAuthority: testWindowsPrivateDirectoryAuthority,
      });
      const generation = await isolatedServerExecutionTest.createRemoteScratchGeneration(
        run,
        "attachments-",
      );
      const materialized = await isolatedServerExecutionTest.materializeRemoteAttachments(
        [
          {
            fileName: "note.txt",
            displayPath: "note.txt",
            sizeBytes: 5,
            contentBase64: Buffer.from("hello").toString("base64"),
          },
        ],
        generation.path,
        "attachment",
      );

      expect(
        await isolatedServerExecutionTest.removeRemoteScratchGeneration(
          generation,
          materialized.files,
        ),
      ).toBe(false);
      expect(replacementPath).toBe(generation.path);
      expect((await lstat(replacementPath!)).isDirectory()).toBe(true);
      expect(await readdir(replacementPath!)).toEqual([]);
      expect((await lstat(`${generation.path}-displaced`)).isDirectory()).toBe(true);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await rm(ambient, { recursive: true, force: true });
    }
  });

  test("projects host artifact paths out of remote messages", () => {
    const scratchPath = "/private/var/folders/test/oracle-serve-run/attachments-123/1-note.txt";
    const artifactPath = "C:\\Users\\oracle\\artifacts\\remote-token\\result.zip";
    const projected = serverExecutionTest.projectRemoteHostText(
      `attachment ${scratchPath} failed; artifact ${artifactPath} failed`,
    );
    expect(projected).not.toContain(scratchPath);
    expect(projected).not.toContain(artifactPath);
    expect(projected).toContain("[host-path]");
  });
});
