import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import type { BrowserRunResult } from "../../src/browserMode.js";
import type { BrowserRunTransaction } from "../../src/browser/types.js";
import type { retryBrowserRecoveryCleanup } from "../../src/browser/reattach.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import {
  __test__ as targetCloseAuthorityTest,
  retainChromeTargetCloseCapability,
} from "../../src/browser/targetCloseAuthority.js";
import {
  CAN_LISTEN_LOCALHOST,
  browserTransaction,
  createTestRemoteServer,
  createTestRemoteBrowserTransactionExecutor as createRemoteBrowserTransactionExecutor,
  committedPromptEpoch,
  remoteRunPayload,
} from "./serverTestBuilders.js";
import { httpPostJson, httpPostNdjson } from "./serverTestHttp.js";
import { readAuthenticatedTransactionRecord } from "./serverTestTransactions.js";
import { openTestRemoteTransactionStore } from "./testTransactionStore.js";

describe("remote browser service", { timeout: 15_000 }, () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "returns canonical bound and completed authority on opposite-mode conflicts",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-http-conflict-"));
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
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
        const transaction = await createRemoteBrowserTransactionExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "a".repeat(64),
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
            token: "a".repeat(64),
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
            token: "a".repeat(64),
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
    "publishes the committed archive result without changing the durable pre-archive capture",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-archive-result-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const transactionToken = "0".repeat(64);
      const preArchiveResult: BrowserRunResult = {
        answerText: "archived answer",
        answerMarkdown: "archived answer",
        tookMs: 2,
        answerTokens: 2,
        answerChars: 15,
      };
      const archive = {
        mode: "always" as const,
        attempted: true,
        archived: true,
        conversationUrl: "https://chatgpt.com/c/remote-conversation",
      };
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) => {
            const transaction = browserTransaction(
              options.prompt,
              { ...preArchiveResult, archive },
              { conversationId: "remote-conversation" },
            );
            await options.preArchiveCaptureCb?.(preArchiveResult, transaction.runtime);
            return transaction;
          },
        },
      );
      try {
        const response = await httpPostNdjson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/run`,
          token: "a".repeat(64),
          body: {
            ...remoteRunPayload(),
            browserConfig: { archiveConversations: "always" },
          },
        });
        expect(response.events).toContainEqual(
          expect.objectContaining({
            type: "transaction",
            transaction: expect.objectContaining({
              result: expect.objectContaining({ answerText: "archived answer", archive }),
            }),
          }),
        );
        expect(preArchiveResult).not.toHaveProperty("archive");
        const store = await openTestRemoteTransactionStore({
          directory: transactionStoreDir,
          integrityKeyPath: path.join(
            path.dirname(transactionStoreDir),
            ".remote-transaction-integrity.key",
          ),
          controllerGeneration: "archive-result-reader",
        });
        expect(await store.read(transactionToken)).toMatchObject({
          state: "pending",
          result: { answerText: "archived answer", archive },
        });
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
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
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
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
          token: "a".repeat(64),
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
        const record = await openTestRemoteTransactionStore({
          directory: transactionStoreDir,
          integrityKeyPath: path.join(
            path.dirname(transactionStoreDir),
            ".remote-transaction-integrity.key",
          ),
          controllerGeneration: "staged-publication-reader",
        });
        const published = await record.read("1".repeat(64));
        expect(published).toMatchObject({
          state: "pending",
          result: { answerText: "staged exact answer" },
        });
        expect(published).not.toHaveProperty("stagedCapture");
        expect(publishCapture).toHaveBeenCalledOnce();
        const settlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${"1".repeat(64)}/finalize`,
          token: "a".repeat(64),
          body: { durablePublication: true },
        });
        expect(settlement).toMatchObject({ statusCode: 200, json: { state: "finalized" } });
      } finally {
        publishCapture.mockRestore();
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "promotes the durable pre-archive capture after target liveness loss without erasing cleanup authority",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-staged-restart-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const transactionToken = "2".repeat(64);
      const prompt = "restart after archive";
      const targetId = "lost-after-archive";
      const targetGenerationId = "lost-after-archive-generation";
      const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
      targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
      const targetCloseCapability = retainChromeTargetCloseCapability({
        ownerId: transactionToken,
        generationId: targetGenerationId,
        targetId,
        close: closeTarget,
      });
      const runtime: BrowserRunTransaction["runtime"] = {
        browserTransport: "cdp",
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeTargetId: targetId,
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch(prompt),
        recoveryCleanupResources: [
          {
            chromeHost: "127.0.0.1",
            chromePort: 9222,
            chromeTargetId: targetId,
            targetCloseCapability,
            acquisition: { generationId: targetGenerationId },
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
      const beforeCrash = await openTestRemoteTransactionStore({
        directory: transactionStoreDir,
        integrityKeyPath: path.join(
          path.dirname(transactionStoreDir),
          ".remote-transaction-integrity.key",
        ),
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
        artifacts: [],
      });
      const resumeBrowser = vi.fn(async () => {
        throw new Error("retry must not recapture a durable staged answer");
      });
      const restarted = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
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
          token: "a".repeat(64),
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
        expect(retry).not.toMatchObject({
          json: { transaction: { result: { archive: expect.anything() } } },
        });
        expect(resumeBrowser).not.toHaveBeenCalled();
        const record = await readAuthenticatedTransactionRecord(
          transactionStoreDir,
          transactionToken,
        );
        expect(record).toMatchObject({
          state: "pending",
          result: { answerText: "restart-safe staged answer" },
          runtime: {
            chromeHost: "127.0.0.1",
            chromePort: 9222,
            conversationId: "remote-conversation",
            promptEpoch: committedPromptEpoch(prompt),
            recoveryCleanupResources: [
              {
                chromeTargetId: targetId,
                targetCloseCapability,
                acquisition: { generationId: targetGenerationId },
                recoveryCleanup: {
                  ownsTarget: true,
                  closeOwnedTargetOnComplete: true,
                },
              },
            ],
          },
        });
        if (!record.runtime) {
          throw new Error("Authenticated promoted capture is missing durable runtime authority");
        }
        expect(record.runtime).not.toHaveProperty("chromeTargetId");
        expect(record.runtime.recoveryCleanupResources).toStrictEqual(
          runtime.recoveryCleanupResources,
        );
        expect(record.result).not.toHaveProperty("archive");
        expect(record).not.toHaveProperty("stagedCapture");

        const settlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: restarted.port,
          path: `/transactions/${transactionToken}/finalize`,
          token: "a".repeat(64),
          body: { durablePublication: true },
        });
        expect(settlement).toMatchObject({ statusCode: 200, json: { state: "finalized" } });
        expect(closeTarget).toHaveBeenCalledOnce();
      } finally {
        await restarted.close();
        targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "publishes a pre-manifest staged capture without browser recapture",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-pre-artifact-crash-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const transactionToken = "8".repeat(64);
      const prompt = "restart before artifact registration";
      const runtime: BrowserRunTransaction["runtime"] = {
        chromeTargetId: "pre-artifact-crash-target",
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch(prompt),
        recoveryCleanupResources: [
          {
            chromeTargetId: "pre-artifact-crash-target",
            conversationId: "remote-conversation",
            promptEpoch: committedPromptEpoch(prompt),
            recoveryCleanup: {
              ownsTarget: false,
              profileKind: "none",
              keepBrowser: false,
              closeOwnedTargetOnComplete: false,
            },
          },
        ],
      };
      const beforeCrash = await openTestRemoteTransactionStore({
        directory: transactionStoreDir,
        integrityKeyPath: path.join(
          path.dirname(transactionStoreDir),
          ".remote-transaction-integrity.key",
        ),
        controllerGeneration: "controller-before-pre-artifact-crash",
      });
      await beforeCrash.begin({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        transactionToken,
        runId: "run-pre-artifact-crash",
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
        runId: "run-pre-artifact-crash",
        result: {
          answerText: "pre-artifact staged answer",
          answerMarkdown: "pre-artifact staged answer",
          tookMs: 2,
          answerTokens: 4,
          answerChars: 26,
        },
        runtime,
      });
      const resumeBrowser = vi.fn(async () => {
        throw new Error("retry must not recapture a durable staged answer");
      });
      const restarted = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir,
          controllerGeneration: "controller-after-pre-artifact-crash",
          resumeBrowser,
        },
      );

      try {
        const retry = await httpPostJson({
          hostname: "127.0.0.1",
          port: restarted.port,
          path: `/transactions/${transactionToken}/retry`,
          token: "a".repeat(64),
          body: {},
        });
        expect(retry).toMatchObject({
          statusCode: 200,
          json: {
            status: "transaction",
            transaction: {
              result: {
                answerText: "pre-artifact staged answer",
                warnings: expect.arrayContaining([
                  expect.objectContaining({ code: "remote-artifact-manual-copy-required" }),
                ]),
              },
            },
          },
        });
        expect(resumeBrowser).not.toHaveBeenCalled();
        const record = await openTestRemoteTransactionStore({
          directory: transactionStoreDir,
          integrityKeyPath: path.join(
            path.dirname(transactionStoreDir),
            ".remote-transaction-integrity.key",
          ),
          controllerGeneration: "pre-artifact-crash-reader",
        }).then((store) => store.read(transactionToken));
        expect(record).toMatchObject({
          state: "pending",
          result: {
            answerText: "pre-artifact staged answer",
            warnings: expect.arrayContaining([
              expect.objectContaining({ code: "remote-artifact-manual-copy-required" }),
            ]),
          },
          artifacts: [],
        });
        expect(record).not.toHaveProperty("stagedCapture");
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
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
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
          token: "a".repeat(64),
          body: remoteRunPayload(),
        });
        expect(run.events.some((event) => event.type === "transaction")).toBe(false);
        expect(retryCleanup).toHaveBeenCalledOnce();
        expect(retryCleanup.mock.calls[0]?.[3]).toBe("abort");
        const retry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/retry`,
          token: "a".repeat(64),
          body: {},
        });
        expect(retry).toMatchObject({
          statusCode: 200,
          json: { status: "terminal", outcome: { state: "aborted" } },
        });
        const record = await readAuthenticatedTransactionRecord(
          transactionStoreDir,
          transactionToken,
        );
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
