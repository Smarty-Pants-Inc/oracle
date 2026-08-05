import {
  projectBrowserCaptureCleanupRuntime,
  projectBrowserCaptureFinalization,
} from "../browser/runLifecycle.js";
import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type { BrowserRemoteRecoveryMetadata, BrowserRuntimeMetadata } from "../sessionManager.js";
import type { RemotePublicRuntime } from "./types.js";

export function findRemoteRecoveryAuthority(
  runtime: BrowserRuntimeMetadata,
): BrowserRemoteRecoveryMetadata | undefined {
  return runtime.recoveryCleanupResources?.find((resource) => resource.remoteRecovery)
    ?.remoteRecovery;
}

export function projectRemoteRecoveryRuntime(
  runtime: RemotePublicRuntime,
  remoteRecovery: BrowserRemoteRecoveryMetadata | null,
  authoritativeRuntime: BrowserRuntimeMetadata = {},
): BrowserRuntimeMetadata {
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

export function projectRemoteRecoveryFinalization(
  authoritativeRuntime: BrowserRuntimeMetadata,
  finalization: BrowserCaptureFinalizationResult,
  settlementMode?: "finalize" | "abort",
): BrowserCaptureFinalizationResult {
  return projectBrowserCaptureFinalization(authoritativeRuntime, finalization, settlementMode);
}
