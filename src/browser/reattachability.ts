import path from "node:path";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { extractStableConversationIdFromUrl, isStableConversationUrl } from "./conversationUrl.js";
import {
  parseChromeProcessIdentity,
  parseChromeProcessLaunchClaim,
  parseProfileDirectoryIdentity,
  sameChromeProcessIdentity,
  sameChromeProcessLaunchClaim,
  sameProfileDirectoryIdentity,
} from "./profileState.js";

export type CommittedBrowserPromptEpoch = Extract<
  NonNullable<BrowserRuntimeMetadata["promptEpoch"]>,
  { status: "committed" }
>;

export interface CommittedPromptEpochLocator {
  epoch: CommittedBrowserPromptEpoch;
  conversationId: string;
  promptSha256: string;
  verifiedUserTurnIndex: number;
  verifiedUserTurnId: string;
  verifiedUserMessageId: string;
  conversationUrls: readonly string[];
}

/**
 * True when the URL points at a specific ChatGPT conversation (`/c/<id>`) on
 * chatgpt.com or chat.openai.com. Rejects home, project shell, and external
 * URLs — anything else would be unsafe to auto-reopen in a persistent
 * signed-in browser profile.
 */
export function isRecoverableChatGptConversationUrl(candidate: string | null | undefined): boolean {
  const trimmed = candidate?.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.port) {
      return false;
    }
    if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") {
      return false;
    }
    return isStableConversationUrl(url.pathname);
  } catch {
    return false;
  }
}

export function resolveCommittedPromptEpochLocator(
  runtime: BrowserRuntimeMetadata | null | undefined,
  additionalConversationUrls: readonly unknown[] = [],
): CommittedPromptEpochLocator | null {
  const epoch = runtime?.promptEpoch;
  if (
    !runtime ||
    !epoch ||
    epoch.status !== "committed" ||
    typeof epoch.epochId !== "string" ||
    !epoch.epochId.trim() ||
    typeof epoch.promptSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(epoch.promptSha256) ||
    !Number.isInteger(epoch.baselineTurns) ||
    epoch.baselineTurns < 0 ||
    !Number.isInteger(epoch.followUpOrdinal) ||
    epoch.followUpOrdinal < 0 ||
    !Number.isInteger(epoch.remainingFollowUps) ||
    epoch.remainingFollowUps < 0 ||
    !Number.isInteger(epoch.verifiedUserTurnIndex) ||
    epoch.verifiedUserTurnIndex < epoch.baselineTurns ||
    typeof epoch.conversationId !== "string" ||
    !/^[a-zA-Z0-9-]+$/.test(epoch.conversationId) ||
    typeof epoch.verifiedUserTurnId !== "string" ||
    !epoch.verifiedUserTurnId.trim() ||
    typeof epoch.verifiedUserMessageId !== "string" ||
    !epoch.verifiedUserMessageId.trim()
  ) {
    return null;
  }

  if (
    runtime.conversationId !== undefined &&
    (typeof runtime.conversationId !== "string" ||
      runtime.conversationId.trim() !== epoch.conversationId)
  ) {
    return null;
  }

  const conversationUrls: string[] = [];
  for (const candidate of [...additionalConversationUrls, runtime.tabUrl]) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    if (typeof candidate !== "string") return null;
    const url = candidate.trim();
    if (!url) continue;
    if (
      !isRecoverableChatGptConversationUrl(url) ||
      extractStableConversationIdFromUrl(url) !== epoch.conversationId
    ) {
      return null;
    }
    conversationUrls.push(url);
  }

  return {
    epoch,
    conversationId: epoch.conversationId,
    promptSha256: epoch.promptSha256,
    verifiedUserTurnIndex: epoch.verifiedUserTurnIndex,
    verifiedUserTurnId: epoch.verifiedUserTurnId.trim(),
    verifiedUserMessageId: epoch.verifiedUserMessageId.trim(),
    conversationUrls,
  };
}

export function requiresCleanupOnlyCommittedPromptRecovery(
  runtime: BrowserRuntimeMetadata | null | undefined,
): boolean {
  const epoch = runtime?.promptEpoch;
  return (
    epoch?.status === "committed" &&
    Number.isInteger(epoch.remainingFollowUps) &&
    epoch.remainingFollowUps > 0
  );
}

export function hasRecoverableChatGptConversation(
  runtime: BrowserRuntimeMetadata | null | undefined,
): boolean {
  const locator = resolveCommittedPromptEpochLocator(runtime);
  return locator !== null && locator.epoch.remainingFollowUps === 0;
}

export function hasPendingChromeAcquisitionIntent(
  runtime: BrowserRuntimeMetadata | null | undefined,
): boolean {
  return Boolean(
    runtime?.recoveryCleanupResources?.some(
      (resource) => resource.acquisition?.pendingResource !== undefined,
    ),
  );
}

/**
 * True only for the durable, local pre-effect authority emitted by the browser acquisition
 * transaction. A PID is deliberately ignored: recovery must authenticate the physical profile
 * plus the launch claim, and later phases must also carry the exact acquired process authority.
 */
export function hasExactPendingChromeAcquisitionAuthority(
  runtime: BrowserRuntimeMetadata | null | undefined,
): boolean {
  if (!runtime) return false;
  if (runtime.recoveryCleanupResult?.settlementMode === "finalize") return false;
  const resources = runtime.recoveryCleanupResources;
  if (!Array.isArray(resources) || resources.length !== 1) return false;
  const resource = resources[0];
  if (!resource || resource.remoteRecovery) return false;
  const acquisition = resource.acquisition;
  const pendingResource = acquisition?.pendingResource;
  if (!acquisition || !pendingResource) return false;

  const launchClaim = parseChromeProcessLaunchClaim(acquisition.processLaunchClaim);
  if (!launchClaim || launchClaim.generationId !== acquisition.generationId) return false;
  if (
    acquisition.processOwnerProvenance !== "temporary-launch" &&
    acquisition.processOwnerProvenance !== "manual-canonical-owner"
  ) {
    return false;
  }
  if (
    acquisition.processOwnerDisposition !== "preserve" &&
    acquisition.processOwnerDisposition !== "close-on-last-lease"
  ) {
    return false;
  }
  const profileKind = resource.recoveryCleanup?.profileKind;
  if (
    (acquisition.processOwnerProvenance === "manual-canonical-owner" &&
      profileKind !== "manual-login") ||
    (acquisition.processOwnerProvenance === "temporary-launch" &&
      profileKind !== "temporary" &&
      profileKind !== "copied")
  ) {
    return false;
  }

  const profile = parseProfileDirectoryIdentity(
    resource.profileDirectoryIdentity,
    process.platform,
  );
  if (
    !profile ||
    !resource.userDataDir ||
    !samePlatformPath(resource.userDataDir, profile.canonicalPath)
  ) {
    return false;
  }
  if (
    resource.chromeProfileRoot &&
    !samePlatformPath(resource.chromeProfileRoot, profile.canonicalPath)
  ) {
    return false;
  }
  if (
    (runtime.userDataDir && !samePlatformPath(runtime.userDataDir, profile.canonicalPath)) ||
    (runtime.chromeProfileRoot &&
      !samePlatformPath(runtime.chromeProfileRoot, profile.canonicalPath))
  ) {
    return false;
  }
  if (
    (runtime.chromeHost &&
      resource.chromeHost &&
      runtime.chromeHost.toLowerCase() !== resource.chromeHost.toLowerCase()) ||
    (runtime.chromePort !== undefined &&
      resource.chromePort !== undefined &&
      runtime.chromePort !== resource.chromePort) ||
    (runtime.chromeBrowserWSEndpoint &&
      resource.chromeBrowserWSEndpoint &&
      runtime.chromeBrowserWSEndpoint !== resource.chromeBrowserWSEndpoint)
  ) {
    return false;
  }

  const processIdentity = resource.chromeProcessIdentity
    ? parseChromeProcessIdentity(resource.chromeProcessIdentity, process.platform)
    : null;
  if (resource.chromeProcessIdentity && !processIdentity) return false;
  if (
    processIdentity &&
    (!sameProfileDirectoryIdentity(processIdentity.profileDirectory, profile) ||
      !sameChromeProcessLaunchClaim(processIdentity.launchClaim, launchClaim))
  ) {
    return false;
  }
  const runtimeProcessIdentity = runtime.chromeProcessIdentity
    ? parseChromeProcessIdentity(runtime.chromeProcessIdentity, process.platform)
    : null;
  if (runtime.chromeProcessIdentity && !runtimeProcessIdentity) return false;
  if (
    runtimeProcessIdentity &&
    (!processIdentity || !sameChromeProcessIdentity(runtimeProcessIdentity, processIdentity))
  ) {
    return false;
  }
  if (
    processIdentity &&
    ((resource.chromePid !== undefined && resource.chromePid !== processIdentity.pid) ||
      (runtime.chromePid !== undefined && runtime.chromePid !== processIdentity.pid))
  ) {
    return false;
  }

  if (pendingResource === "tab-lease") {
    const leaseProfile = parseProfileDirectoryIdentity(
      resource.tabLease?.profileDirectory,
      process.platform,
    );
    return Boolean(
      acquisition.processOwnerProvenance === "manual-canonical-owner" &&
      typeof resource.tabLease?.id === "string" &&
      resource.tabLease.id.trim() &&
      leaseProfile &&
      sameProfileDirectoryIdentity(leaseProfile, profile) &&
      !processIdentity &&
      resource.recoveryCleanup?.ownsTarget === false,
    );
  }
  if (pendingResource === "chrome-process") {
    return resource.recoveryCleanup?.ownsTarget === false;
  }
  if (pendingResource === "chrome-target") {
    return Boolean(
      processIdentity &&
      acquisition.targetMarkerUrl ===
        `about:blank#oracle-acquisition=${acquisition.generationId}` &&
      resource.recoveryCleanup?.ownsTarget === true,
    );
  }
  return false;
}

function samePlatformPath(left: string, right: string): boolean {
  const pathApi = process.platform === "win32" ? path.win32 : path.posix;
  const normalizedLeft = pathApi.resolve(left);
  const normalizedRight = pathApi.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
