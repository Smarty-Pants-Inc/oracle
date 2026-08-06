import path from "node:path";

import type { BrowserRuntimeMetadata, SessionMetadata } from "../../src/sessionManager.ts";

export const baseSessionMeta: SessionMetadata = {
  id: "sess-1",
  createdAt: "2025-01-01T00:00:00Z",
  status: "pending",
  options: {},
};

export const baseRunOptions = {
  prompt: "Hello",
  model: "gpt-5.2-pro" as const,
};

export const committedDemoAuthority = {
  conversationId: "demo",
  promptEpoch: {
    status: "committed" as const,
    epochId: "epoch-demo",
    promptSha256: "c".repeat(64),
    baselineTurns: 0,
    followUpOrdinal: 0,
    remainingFollowUps: 0,
    verifiedUserTurnIndex: 1,
    verifiedUserTurnId: "turn-1",
    verifiedUserMessageId: "message-1",
    conversationId: "demo",
  },
} satisfies BrowserRuntimeMetadata;

export function createCleanupRuntime(
  targetId: string,
  status: "pending" | "failed" = "pending",
): BrowserRuntimeMetadata {
  return {
    chromePort: 9222,
    chromeHost: "127.0.0.1",
    chromeTargetId: targetId,
    tabUrl: "https://chatgpt.com/c/demo",
    ...committedDemoAuthority,
    recoveryCleanupResources: [
      {
        chromePort: 9222,
        chromeHost: "127.0.0.1",
        chromeTargetId: targetId,
        conversationId: "demo",
        promptEpoch: committedDemoAuthority.promptEpoch,
        recoveryCleanup: {
          ownsTarget: true,
          profileKind: "temporary",
          keepBrowser: false,
        },
      },
    ],
    recoveryCleanupResult:
      status === "failed"
        ? { status, error: `cleanup failed for ${targetId}`, settlementMode: "abort" }
        : { status },
  };
}

export function createPendingChromeAcquisitionRuntime(): BrowserRuntimeMetadata {
  const userDataDir = path.resolve("/tmp/oracle-pending-acquisition");
  const generationId = "70000000-0000-4000-8000-000000000007";
  return {
    browserTransport: "cdp",
    chromePid: 7_777,
    chromeHost: "127.0.0.1",
    chromeProfileRoot: userDataDir,
    userDataDir,
    controllerPid: 2_147_483_647,
    recoveryCleanupResources: [
      {
        chromePid: 7_777,
        chromeHost: "127.0.0.1",
        chromeProfileRoot: userDataDir,
        userDataDir,
        profileDirectoryIdentity: {
          version: 1,
          platform: process.platform,
          canonicalPath: userDataDir,
          device: "1",
          inode: "2",
        },
        acquisition: {
          generationId,
          pendingResource: "chrome-process",
          processOwnerProvenance: "temporary-launch",
          processLaunchClaim: {
            version: 1,
            generationId,
            nonce: "80000000-0000-4000-8000-000000000008",
          },
          processOwnerDisposition: "close-on-last-lease",
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
}
