import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { createRemoteServer } from "../../src/remote/server.js";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import { RemoteArtifactStore } from "../../src/remote/artifactStore.js";
import {
  createRemoteBrowserExecutor,
  settleRemoteBrowserRecovery,
} from "../../src/remote/client.js";
import type { BrowserLogger, BrowserRunTransaction } from "../../src/browser/types.js";
import type { ReattachDeps, retryBrowserRecoveryCleanup } from "../../src/browser/reattach.js";
import type { BrowserSessionConfig } from "../../src/sessionManager.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import {
  captureProfileDirectoryIdentity,
  readOracleChromeOwner,
  removeProfileDirectoryIfIdentityMatches,
  sameProfileDirectoryIdentity,
  writeOracleChromeOwner,
} from "../../src/browser/profileState.js";
import { completedBrowserCaptureCleanup } from "../../src/browser/runLifecycle.js";
import {
  CAN_LISTEN_LOCALHOST,
  committedPromptEpoch,
  lifecycleBrowserTransaction,
} from "./serverTestBuilders.js";
import { httpPostJson } from "./serverTestHttp.js";
import { remoteRecoveryTransactionToken, seedRemoteTransaction } from "./serverTestTransactions.js";

describe("remote browser service", { timeout: 15_000 }, () => {
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
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
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
          token: "a".repeat(64),
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
            authToken: "a".repeat(64),
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

  test.skipIf(!CAN_LISTEN_LOCALHOST).each([
    {
      name: "committed prompt mismatch",
      code: "committed-prompt-identity-mismatch",
      reattachable: undefined,
    },
    {
      name: "Gemini non-reattachable authority",
      code: "gemini-reattach-authority-unavailable",
      reattachable: false,
    },
  ])("durably aborts terminal retry errors: $name", async ({ code, reattachable }) => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-terminal-retry-"));
    const transactionStoreDir = path.join(tmpDir, "transactions");
    const transactionToken = "9".repeat(64);
    const prompt = "terminal retry authority";
    const runtime: BrowserRunTransaction["runtime"] = {
      conversationId: "remote-conversation",
      promptEpoch: committedPromptEpoch(prompt),
      recoveryCleanupResources: [
        {
          chromeTargetId: "terminal-retry-target",
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
    const seeded = await RemoteTransactionStore.open({
      directory: transactionStoreDir,
      controllerGeneration: "controller-before-terminal-retry",
    });
    await seedRemoteTransaction(seeded, transactionToken, {
      prompt,
      state: "recoverable-error",
      runtime,
    });
    const retryCleanup = vi.fn<typeof retryBrowserRecoveryCleanup>(async (cleanupRuntime) => ({
      status: "completed" as const,
      runtime: cleanupRuntime,
    }));
    const resumeBrowser = vi.fn(async (recoveryRuntime: BrowserRunTransaction["runtime"]) => {
      throw new BrowserAutomationError("Recovery authority is terminal", {
        stage: "prompt-epoch",
        code,
        recoverableDisconnect: true,
        reattachable,
        runtime: recoveryRuntime,
      });
    });
    const server = await createRemoteServer(
      { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
      {
        transactionStoreDir,
        controllerGeneration: "controller-after-terminal-retry",
        resumeBrowser,
        retryCleanup,
      },
    );

    try {
      const retry = await httpPostJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: `/transactions/${transactionToken}/retry`,
        token: "a".repeat(64),
        body: {},
      });
      expect(retry).toMatchObject({
        statusCode: 200,
        json: {
          status: "terminal",
          outcome: {
            state: "aborted",
            error: { code, recoverableDisconnect: false },
          },
        },
      });
      expect(resumeBrowser).toHaveBeenCalledOnce();
      expect(retryCleanup).toHaveBeenCalledOnce();
      expect(retryCleanup.mock.calls[0]?.[3]).toBe("abort");
      const record = await RemoteTransactionStore.open({
        directory: transactionStoreDir,
        controllerGeneration: "terminal-retry-reader",
      }).then((store) => store.read(transactionToken));
      expect(record).toMatchObject({
        state: "aborted",
        terminalAudit: {
          settlementMode: "abort",
          errorCode: code,
          errorStage: "prompt-epoch",
        },
      });
      expect(record).not.toHaveProperty("error");
      expect(record).not.toHaveProperty("runtime");
    } finally {
      await server.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
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
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
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
          token: "a".repeat(64),
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
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        { transactionStoreDir, resumeBrowser },
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
          token: "a".repeat(64),
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
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
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
          token: "a".repeat(64),
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
      setOracleHomeDirOverrideForTest(tmpDir);
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const previousControllerGeneration = "controller-before-recovery";
      const recoveryControllerGeneration = "controller-after-recovery";
      const prompt = "recovery acquisition journal";
      const profileDirectory = {
        version: 2 as const,
        platform: process.platform,
        canonicalPath: "/tmp/oracle-retry-runtime-hints",
        device: "1",
        inode: "2",
        birthtimeNs: "3",
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
      const seededArtifacts = new RemoteArtifactStore({
        transactionStore: previousController,
        sessionsRoot: path.join(tmpDir, "sessions"),
      });
      await seededArtifacts.createArtifactWriteAuthority({
        transactionToken,
        runId: `run-${transactionToken.slice(0, 8)}`,
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
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
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
            token: "a".repeat(64),
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
        setOracleHomeDirOverrideForTest(null);
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
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
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
          token: "a".repeat(64),
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
          token: "a".repeat(64),
          body: {},
        });
        expect(retry).toMatchObject({
          statusCode: 200,
          json: {
            status: "error",
            error: {
              code: "remote-settlement-pending",
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
          error: {
            code: "remote-prompt-authority-mismatch",
            recoverableDisconnect: false,
          },
          settlementMode: "abort",
          finalization: { status: "pending" },
        });
        await expect(server.close()).rejects.toThrow("cleanup remains pending");
        expect(abort).toHaveBeenCalledTimes(2);
        const cleanupRetry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/retry`,
          token: "a".repeat(64),
          body: {},
        });
        expect(cleanupRetry).toMatchObject({
          statusCode: 200,
          json: { status: "terminal", outcome: { state: "aborted" } },
        });
        expect(abort).toHaveBeenCalledTimes(3);
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

      let cleanupAttempts = 0;
      const exactChromeCleanup = vi.fn(
        async (_recordedRuntime: BrowserRunTransaction["runtime"], recordedProfileDir: string) => {
          cleanupAttempts += 1;
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
          return cleanupAttempts === 1
            ? {
                status: "unsafe" as const,
                pid: identity.pid,
                reason: "exact cleanup capability is temporarily unavailable",
              }
            : {
                status: "stopped" as const,
                pid: identity.pid,
                signal: "CONTROL_CHANNEL" as const,
              };
        },
      );
      const unusedProfileUse = { status: "unused" as const, candidates: [] };
      const removeCleanupProfile = vi.fn(
        async (recordedProfileDir: string, expectedIdentity: typeof profileDirectory) => {
          expect(sameProfileDirectoryIdentity(expectedIdentity, profileDirectory)).toBe(true);
          return removeProfileDirectoryIfIdentityMatches(recordedProfileDir, expectedIdentity, {
            inspectChromeProfileDirectoryUse: async () => unusedProfileUse,
            revalidateChromeProfileDirectoryUse: async () => unusedProfileUse,
          });
        },
      );
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir,
          controllerGeneration: "controller-after-restart",
          exactChromeCleanup,
          removeCleanupProfile,
        },
      );
      try {
        const firstSettlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/abort`,
          token: "a".repeat(64),
          body: {},
        });
        expect(firstSettlement, JSON.stringify(firstSettlement.json)).toMatchObject({
          statusCode: 200,
          json: {
            state: "pending",
            settlementAuthority: { mode: "abort", outcome: "bound", state: "pending" },
            finalization: { status: "pending" },
          },
        });
        expect(exactChromeCleanup).toHaveBeenCalledOnce();
        expect(removeCleanupProfile).not.toHaveBeenCalled();
        await expect(stat(profileDir)).resolves.toBeDefined();
        await expect(seeded.read(transactionToken)).resolves.toMatchObject({
          state: "pending",
          settlementMode: "abort",
          finalization: { status: "pending" },
        });

        const completedSettlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/abort`,
          token: "a".repeat(64),
          body: {},
        });
        expect(completedSettlement, JSON.stringify(completedSettlement.json)).toMatchObject({
          statusCode: 200,
          json: { state: "aborted" },
        });
        expect(exactChromeCleanup).toHaveBeenCalledTimes(2);
        expect(
          exactChromeCleanup.mock.calls.map(
            ([cleanupRuntime]) => cleanupRuntime.recoveryCleanupResult?.settlementMode,
          ),
        ).toEqual(["abort", "abort"]);
        expect(exactChromeCleanup).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ chromeProcessIdentity: identity }),
          expect.any(String),
          identity,
          expect.any(Function),
        );
        expect(removeCleanupProfile).toHaveBeenCalledOnce();
        await expect(stat(profileDir)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(seeded.read(transactionToken)).resolves.toMatchObject({
          state: "aborted",
          terminalAudit: { settlementMode: "abort" },
        });

        const replayedSettlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/abort`,
          token: "a".repeat(64),
          body: {},
        });
        expect(replayedSettlement, JSON.stringify(replayedSettlement.json)).toMatchObject({
          statusCode: 200,
          json: { state: "aborted" },
        });
        expect(exactChromeCleanup).toHaveBeenCalledTimes(2);
        expect(removeCleanupProfile).toHaveBeenCalledOnce();
      } finally {
        await server.close();
        await rm(profileDir, { recursive: true, force: true });
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
