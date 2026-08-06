import { projectBrowserCaptureCleanupRuntime } from "../browser/ownedBrowserResources.js";
import type { BrowserRemoteRecoveryMetadata, BrowserRuntimeMetadata } from "../sessionManager.js";
import type { RemotePublicRuntime } from "./types.js";
import { assertRemoteRecoveryAuthority } from "../browser/reattachability.js";
export { findRemoteRecoveryAuthority } from "../browser/reattachability.js";

export function projectRemoteRecoveryRuntime(
  runtime: RemotePublicRuntime,
  remoteRecovery: BrowserRemoteRecoveryMetadata | null,
  authoritativeRuntime: BrowserRuntimeMetadata = {},
): BrowserRuntimeMetadata {
  if (remoteRecovery) assertRemoteRecoveryAuthority(remoteRecovery);
  const promptEpoch = runtime.promptEpoch;
  const resourceRuntime: BrowserRuntimeMetadata = {
    conversationId: promptEpoch?.conversationId,
    promptEpoch,
    recoveryCleanupResources: remoteRecovery
      ? [
          {
            conversationId: promptEpoch?.conversationId,
            promptEpoch,
            remoteRecovery,
            recoveryCleanup: {
              ownsTarget: false,
              profileKind: "none",
              keepBrowser: false,
            },
          },
        ]
      : undefined,
    ...(remoteRecovery && remoteRecovery.state !== "pre-receipt"
      ? { recoveryCleanupResult: { status: "pending" as const } }
      : {}),
  };
  const projected = projectBrowserCaptureCleanupRuntime(authoritativeRuntime, resourceRuntime);
  return {
    ...(projected.conversationId ? { conversationId: projected.conversationId } : {}),
    ...(projected.promptEpoch ? { promptEpoch: projected.promptEpoch } : {}),
    ...(projected.recoveryCleanupResources
      ? {
          recoveryCleanupResources: projected.recoveryCleanupResources.map((resource) => ({
            ...(resource.conversationId ? { conversationId: resource.conversationId } : {}),
            ...(resource.promptEpoch ? { promptEpoch: resource.promptEpoch } : {}),
            ...(resource.remoteRecovery ? { remoteRecovery: resource.remoteRecovery } : {}),
            recoveryCleanup: resource.recoveryCleanup,
          })),
        }
      : {}),
    ...(projected.recoveryCleanupResult
      ? { recoveryCleanupResult: projected.recoveryCleanupResult }
      : {}),
  };
}
