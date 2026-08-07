import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { BrowserRunOptions, BrowserRunResult } from "../../src/browserMode.js";
import type { BrowserRunTransaction } from "../../src/browser/types.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import { createBrowserRunTransaction } from "../../src/browser/runLifecycle.js";
import {
  OwnedBrowserResourceTransaction,
  type OwnedBrowserResourceTransactionAdapters,
} from "../../src/browser/ownedBrowserResources.js";
import { createRemoteServer } from "../../src/remote/server.js";
import {
  createRemoteBrowserExecutor,
  createRemoteBrowserTransactionExecutor,
  resumeRemoteBrowserTransaction,
} from "../../src/remote/client.js";
import {
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  type RemoteArtifactDescriptor,
  type RemoteRunPayload,
} from "../../src/remote/types.js";
import { testWindowsPrivateTreeAuthority } from "./testTransactionStore.js";
import {
  testWindowsPrivateDirectoriesAuthority,
  testWindowsPrivateFileInitializationAuthority,
  testWindowsPrivateFileProtectionAuthority,
  testWindowsPrivateFileVerificationAuthority,
} from "../privateAuthorityTestHelpers.js";
import { testProcessIdentityProvider } from "../browser/filesystemLockTestHelpers.js";

export function createTestRemoteServer(
  options: Parameters<typeof createRemoteServer>[0] = {},
  deps: Parameters<typeof createRemoteServer>[1] = {},
) {
  return createRemoteServer(options, {
    windowsPrivateTreeAuthority: testWindowsPrivateTreeAuthority,
    windowsPrivateDirectoriesAuthority: testWindowsPrivateDirectoriesAuthority,
    windowsPrivateFileProtectionAuthority: testWindowsPrivateFileProtectionAuthority,
    windowsPrivateFileVerificationAuthority: testWindowsPrivateFileVerificationAuthority,
    ...deps,
    controllerLockDeps: {
      processIdentityProvider: testProcessIdentityProvider,
      ...deps.controllerLockDeps,
    },
  });
}

const testArtifactTransferDeps = {
  windowsPrivateDirectoriesAuthority: testWindowsPrivateDirectoriesAuthority,
  windowsPrivateFileInitializationAuthority: testWindowsPrivateFileInitializationAuthority,
  windowsPrivateFileVerificationAuthority: testWindowsPrivateFileVerificationAuthority,
};

export function createTestRemoteBrowserTransactionExecutor(
  options: Parameters<typeof createRemoteBrowserTransactionExecutor>[0],
) {
  return createRemoteBrowserTransactionExecutor(options, {
    artifactTransferDeps: testArtifactTransferDeps,
  });
}

export function createTestRemoteBrowserExecutor(
  options: Parameters<typeof createRemoteBrowserExecutor>[0],
) {
  return createRemoteBrowserExecutor(options, { artifactTransferDeps: testArtifactTransferDeps });
}

export function resumeTestRemoteBrowserTransaction(
  params: Parameters<typeof resumeRemoteBrowserTransaction>[0],
) {
  return resumeRemoteBrowserTransaction({
    ...params,
    artifactTransferDeps: testArtifactTransferDeps,
  });
}

export const CAN_LISTEN_LOCALHOST =
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

export function committedPromptEpoch(
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

export function browserTransaction(
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

export function lifecycleBrowserTransaction(
  prompt: string,
  result: BrowserRunResult,
  runtime: BrowserRunTransaction["runtime"],
  runtimeHintCb: BrowserRunOptions["runtimeHintCb"],
  settleResources: OwnedBrowserResourceTransactionAdapters["settleResources"],
  followUpOrdinal = 0,
): BrowserRunTransaction {
  const conversationId = result.conversationId?.trim() || "remote-conversation";
  const capturedRuntime: BrowserRunTransaction["runtime"] = {
    ...runtime,
    conversationId,
    promptEpoch: committedPromptEpoch(prompt, conversationId, followUpOrdinal),
  };
  const settlement = new OwnedBrowserResourceTransaction(
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

export function createArtifactDescriptor(
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

export function remoteRunPayload(): RemoteRunPayload {
  return {
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    prompt: "remote test",
    attachments: [],
    browserConfig: {},
    options: {},
  };
}
