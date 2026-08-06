import path from "node:path";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import type { BrowserRunTransaction } from "../../src/browser/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";
import { committedPromptEpoch } from "./serverTestBuilders.js";
import { openTestRemoteTransactionStore } from "./testTransactionStore.js";

export const TEST_CONTROLLER_GENERATION = "server-test-controller";

export async function openSeedTransactionStore(
  directory: string,
  leaseDurationMs: number,
  now: () => number,
) {
  return await openTestRemoteTransactionStore({
    directory,
    integrityKeyPath: path.join(path.dirname(directory), ".remote-transaction-integrity.key"),
    controllerGeneration: TEST_CONTROLLER_GENERATION,
    leaseDurationMs,
    now,
  });
}

export async function readAuthenticatedTransactionRecord(
  directory: string,
  transactionToken: string,
) {
  const store = await openTestRemoteTransactionStore({
    directory,
    integrityKeyPath: path.join(path.dirname(directory), ".remote-transaction-integrity.key"),
    controllerGeneration: "server-test-authenticated-reader",
  });
  const record = await store.read(transactionToken);
  if (!record) throw new Error(`Missing authenticated remote transaction ${transactionToken}`);
  return record;
}

export async function seedRemoteTransaction(
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

export function remoteRecoveryTransactionToken(error: unknown) {
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
