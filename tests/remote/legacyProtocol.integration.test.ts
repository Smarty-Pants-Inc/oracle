import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";
import { createRemoteServer } from "../../src/remote/server.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import type { BrowserRunResult, BrowserRunTransaction } from "../../src/browser/types.js";
import { RemoteLegacyTextResultSchema } from "../../src/remote/legacyProtocol.js";
import {
  browserRunResultFromTransaction,
  projectRemotePublicResult,
} from "../../src/remote/transactionCapture.js";
import { CAN_LISTEN_LOCALHOST } from "./serverTestBuilders.js";

// This exercises Node's actual TCP response-idle timer; fake timers cannot advance socket I/O.
const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function capturedTransaction(prompt: string, result: BrowserRunResult): BrowserRunTransaction {
  const runtime: BrowserRunTransaction["runtime"] = {
    conversationId: "legacy-conversation",
    promptEpoch: {
      status: "committed",
      epochId: "legacy-epoch",
      promptSha256: promptIdentitySha256(prompt),
      baselineTurns: 0,
      followUpOrdinal: 0,
      remainingFollowUps: 0,
      verifiedUserTurnIndex: 0,
      verifiedUserTurnId: "legacy-user-turn",
      verifiedUserMessageId: "legacy-user-message",
      conversationId: "legacy-conversation",
    },
  };
  let settlementMode: "finalize" | "abort" | undefined;
  const bindSettlement = async (mode: "finalize" | "abort") => {
    if (settlementMode && settlementMode !== mode) {
      throw new Error(`legacy transaction is already bound to ${settlementMode}`);
    }
    settlementMode = mode;
    return runtime;
  };
  return {
    ...result,
    runtime,
    bindSettlement,
    finalize: async () => ({ status: "completed", runtime: await bindSettlement("finalize") }),
    abort: async () => ({ status: "completed", runtime: await bindSettlement("abort") }),
  };
}

describe("legacy remote protocol integration", () => {
  test("keeps the predecessor result schema strict", () => {
    expect(
      RemoteLegacyTextResultSchema.safeParse({
        answerText: "durable",
        answerMarkdown: "**durable**",
        tookMs: 1,
        answerTokens: 2,
        answerChars: 7,
        archive: { mode: "always", attempted: true, archived: true },
        modelSelection: { status: "already-selected" },
      }).success,
    ).toBe(false);
  });

  test("retains prompt submission in the strict public result projection", () => {
    const result = projectRemotePublicResult(
      browserRunResultFromTransaction(
        capturedTransaction("public projection prompt", {
          answerText: "done",
          answerMarkdown: "done",
          tookMs: 1,
          answerTokens: 1,
          answerChars: 4,
        }),
      ),
    );

    expect(result.promptSubmitted).toBe(true);
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "projects modern capture metadata and resets the legacy idle deadline with common log events",
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-legacy-protocol-"));
      const logEvents: string[] = [];
      const heartbeatPauseMs = 100;
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "a".repeat(64),
          legacyToken: "c".repeat(64),
          logger: () => {},
        },
        {
          transactionStoreDir: path.join(directory, "transactions"),
          runBrowser: async (options) => {
            options.log?.("[browser] legacy heartbeat 1");
            await wait(heartbeatPauseMs);
            options.log?.("[browser] legacy heartbeat 2");
            await wait(heartbeatPauseMs);
            return capturedTransaction(options.prompt, {
              answerText: "durable",
              answerMarkdown: "**durable**",
              answerHtml: "<p>durable</p>",
              archive: {
                mode: "always",
                attempted: true,
                archived: true,
                conversationUrl: "https://chatgpt.com/c/legacy-conversation",
              },
              modelSelection: {
                requestedModel: "gpt-5.6",
                resolvedLabel: "GPT-5.6",
                strategy: "select",
                status: "already-selected",
                verified: true,
                source: "config",
                capturedAt: "2026-08-06T00:00:00.000Z",
              },
              promptSubmitted: true,
              tookMs: heartbeatPauseMs * 2,
              answerTokens: 2,
              answerChars: 7,
            });
          },
        },
      );
      try {
        const transaction = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          legacyToken: "c".repeat(64),
          allowLegacyTextProtocol: true,
          deadlines: {
            runOverallTimeoutMs: 1_000,
            controlOverallTimeoutMs: 1_000,
            artifactOverallTimeoutMs: 1_000,
            socketIdleTimeoutMs: 150,
            recoveryWindowMs: 1_000,
          },
        })({
          prompt: "legacy compatibility prompt",
          config: {},
          verbose: true,
          log: (message) => logEvents.push(message),
        });

        expect(transaction).toMatchObject({
          answerText: "durable",
          answerMarkdown: "**durable**",
          answerHtml: "<p>durable</p>",
          tookMs: heartbeatPauseMs * 2,
          answerTokens: 2,
          answerChars: 7,
        });
        expect(transaction).not.toHaveProperty("archive");
        expect(transaction).not.toHaveProperty("modelSelection");
        expect(logEvents).toEqual(
          expect.arrayContaining(["[browser] legacy heartbeat 1", "[browser] legacy heartbeat 2"]),
        );
        await expect(transaction.finalize()).resolves.toMatchObject({ status: "completed" });
      } finally {
        await server.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
