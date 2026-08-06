import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createRemoteServer } from "../../src/remote/server.js";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";
import type { BrowserRunResult } from "../../src/browserMode.js";
import type { BrowserRunTransaction } from "../../src/browser/types.js";
import type { retryBrowserRecoveryCleanup } from "../../src/browser/reattach.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import {
  CAN_LISTEN_LOCALHOST,
  browserTransaction,
  committedPromptEpoch,
  remoteRunPayload,
} from "./serverTestBuilders.js";
import { httpPostJson, httpPostNdjson } from "./serverTestHttp.js";

describe("remote browser service", { timeout: 15_000 }, () => {
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
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
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
          token: "secret",
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
        const store = await RemoteTransactionStore.open({
          directory: transactionStoreDir,
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
        const settlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${"1".repeat(64)}/finalize`,
          token: "secret",
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
        artifacts: [],
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
        expect(retry).not.toMatchObject({
          json: { transaction: { result: { archive: expect.anything() } } },
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
        expect(record?.result).not.toHaveProperty("archive");
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
    "never promotes a pre-artifact stage from the crash window",
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
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const beforeCrash = await RemoteTransactionStore.open({
        directory: transactionStoreDir,
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
      const resumeBrowser = vi.fn(async (recoveryRuntime: BrowserRunTransaction["runtime"]) => ({
        answerText: "pre-artifact staged answer",
        answerMarkdown: "pre-artifact staged answer",
        runtime: recoveryRuntime,
        bindSettlement: async () => recoveryRuntime,
        finalize: async () => ({ status: "completed" as const, runtime: recoveryRuntime }),
        abort: async () => ({ status: "completed" as const, runtime: recoveryRuntime }),
      }));
      const restarted = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
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
          token: "secret",
          body: {},
        });
        expect(retry).toMatchObject({
          statusCode: 200,
          json: {
            status: "error",
            error: {
              code: "remote-answer-publication-failed",
              recoverableDisconnect: true,
            },
          },
        });
        expect(resumeBrowser).toHaveBeenCalledOnce();
        const record = await RemoteTransactionStore.open({
          directory: transactionStoreDir,
          controllerGeneration: "pre-artifact-crash-reader",
        }).then((store) => store.read(transactionToken));
        expect(record).toMatchObject({
          state: "recoverable-error",
          stagedCapture: { result: { answerText: "pre-artifact staged answer" } },
        });
        expect(record).not.toHaveProperty("result");
        expect(record).not.toHaveProperty("artifacts");
        expect(record?.stagedCapture).not.toHaveProperty("artifacts");
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
