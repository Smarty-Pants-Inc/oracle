import path from "node:path";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import type { BrowserRemoteRecoveryMetadata, BrowserSessionConfig } from "../sessionManager.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../remote/types.js";
import {
  assertRemoteTransactionToken,
  isRemoteTransactionToken,
} from "../remote/transactionToken.js";
import { resolveGeminiWebModel } from "../gemini-web/models.js";
import { extractStableConversationIdFromUrl, isStableConversationUrl } from "./conversationUrl.js";
import { hasImmutableGeminiPromptIdentity } from "./providers/geminiDeepThinkDomProvider.js";
import { parseChromeProcessIdentity, sameChromeProcessIdentity } from "./chromeProcessIdentity.js";
import {
  parseChromeProcessLaunchClaim,
  sameChromeProcessLaunchClaim,
} from "./chromeProcessLaunchClaim.js";
import { parseProfileDirectoryIdentity, sameProfileDirectoryIdentity } from "./profileState.js";
import {
  hasRestartReconstructibleChromeTargetCloseAuthority,
  isBrowserRecoveryTargetCloseCapability,
} from "./targetCloseAuthority.js";
import { recoveryCleanupResourceKey } from "./recoveryCleanupIdentity.js";

export type CommittedBrowserPromptEpoch = Extract<
  NonNullable<BrowserRuntimeMetadata["promptEpoch"]>,
  { status: "committed" }
>;

export type PendingBrowserPromptEpoch = Extract<
  NonNullable<BrowserRuntimeMetadata["promptEpoch"]>,
  { status: "pending" }
>;

export interface PendingPromptEpochAuthority {
  epoch: PendingBrowserPromptEpoch;
  targetId: string;
  conversationId?: string;
  resourceKey: string;
}

function samePendingPromptEpoch(
  expected: PendingBrowserPromptEpoch,
  candidate: BrowserRuntimeMetadata["promptEpoch"],
): boolean {
  return (
    candidate?.status === "pending" &&
    candidate.epochId === expected.epochId &&
    candidate.promptSha256 === expected.promptSha256 &&
    candidate.baselineTurns === expected.baselineTurns &&
    candidate.followUpOrdinal === expected.followUpOrdinal &&
    candidate.remainingFollowUps === expected.remainingFollowUps
  );
}

export function hasPendingPromptEpoch(runtime: BrowserRuntimeMetadata | null | undefined): boolean {
  return runtime?.promptEpoch?.status === "pending";
}

export function resolvePendingPromptEpochAuthority(
  runtime: BrowserRuntimeMetadata | null | undefined,
  ownerId?: string,
): PendingPromptEpochAuthority | null {
  const epoch = runtime?.promptEpoch;
  const targetId = runtime?.chromeTargetId?.trim();
  if (
    !runtime ||
    epoch?.status !== "pending" ||
    !epoch.epochId.trim() ||
    !/^[a-f0-9]{64}$/.test(epoch.promptSha256) ||
    !Number.isInteger(epoch.baselineTurns) ||
    epoch.baselineTurns < 0 ||
    !Number.isInteger(epoch.followUpOrdinal) ||
    epoch.followUpOrdinal < 0 ||
    !Number.isInteger(epoch.remainingFollowUps) ||
    epoch.remainingFollowUps < 0 ||
    !targetId
  ) {
    return null;
  }
  const conversationId =
    runtime.conversationId?.trim() || extractStableConversationIdFromUrl(runtime.tabUrl ?? "");
  if (runtime.conversationId !== undefined && !conversationId) return null;

  let exactOwnedTarget = 0;
  let exactOwnedResourceKey: string | null = null;
  for (const resource of runtime.recoveryCleanupResources ?? []) {
    if (resource.promptEpoch && !samePendingPromptEpoch(epoch, resource.promptEpoch)) return null;
    if (resource.conversationId && conversationId && resource.conversationId !== conversationId) {
      return null;
    }
    if (!resource.recoveryCleanup.ownsTarget) continue;
    if (resource.chromeTargetId?.trim() !== targetId) return null;
    const generationId = resource.acquisition?.generationId?.trim();
    const capability = resource.targetCloseCapability;
    if (
      !generationId ||
      !isBrowserRecoveryTargetCloseCapability(capability) ||
      capability.generationId !== generationId ||
      capability.targetId !== targetId
    ) {
      return null;
    }
    if (
      ownerId !== undefined &&
      !hasRestartReconstructibleChromeTargetCloseAuthority(resource, ownerId)
    ) {
      return null;
    }
    const lease = resource.tabLease;
    if (
      resource.recoveryCleanup.profileKind === "manual-login" &&
      (!lease?.id.trim() || lease.generationId !== generationId)
    ) {
      return null;
    }
    if (lease && (!lease.id.trim() || lease.generationId !== generationId)) return null;
    exactOwnedTarget += 1;
    exactOwnedResourceKey = recoveryCleanupResourceKey(resource);
  }
  return exactOwnedTarget === 1 && exactOwnedResourceKey
    ? { epoch, targetId, conversationId, resourceKey: exactOwnedResourceKey }
    : null;
}

export function isRemoteRecoveryAuthority(value: unknown): value is BrowserRemoteRecoveryMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const authority = value as Partial<BrowserRemoteRecoveryMetadata>;
  if (
    authority.protocolVersion !== REMOTE_TRANSACTION_PROTOCOL_VERSION ||
    typeof authority.host !== "string" ||
    authority.host.length === 0 ||
    authority.host !== authority.host.trim() ||
    !isRemoteTransactionToken(authority.transactionToken) ||
    !["pre-receipt", "pending", "recoverable-error"].includes(authority.state ?? "")
  ) {
    return false;
  }
  const requestIdentity = authority.requestIdentity;
  return (
    requestIdentity === undefined ||
    (Array.isArray(requestIdentity.acceptedPromptSha256) &&
      requestIdentity.acceptedPromptSha256.length > 0 &&
      requestIdentity.acceptedPromptSha256.length <= 2 &&
      new Set(requestIdentity.acceptedPromptSha256).size ===
        requestIdentity.acceptedPromptSha256.length &&
      requestIdentity.acceptedPromptSha256.every((digest) => /^[a-f0-9]{64}$/.test(digest)) &&
      Number.isInteger(requestIdentity.followUpOrdinal) &&
      requestIdentity.followUpOrdinal >= 0 &&
      requestIdentity.followUpOrdinal <= 32 &&
      requestIdentity.remainingFollowUps === 0)
  );
}

export function assertRemoteRecoveryAuthority(
  value: unknown,
): asserts value is BrowserRemoteRecoveryMetadata {
  if (isRemoteRecoveryAuthority(value)) return;
  const transactionToken =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<BrowserRemoteRecoveryMetadata>).transactionToken
      : undefined;
  assertRemoteTransactionToken(transactionToken);
  throw new BrowserAutomationError("Persisted remote recovery authority is invalid.", {
    stage: "remote-resume",
    code: "invalid-remote-recovery-authority",
  });
}

export function findRemoteRecoveryAuthority(
  runtime: BrowserRuntimeMetadata,
): BrowserRemoteRecoveryMetadata | undefined {
  const authority = runtime.recoveryCleanupResources?.find(
    (resource) => resource?.remoteRecovery,
  )?.remoteRecovery;
  if (!authority) return undefined;
  assertRemoteRecoveryAuthority(authority);
  return authority;
}

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
export function requireCommittedPromptEpochLocator(
  runtime: BrowserRuntimeMetadata,
): CommittedPromptEpochLocator {
  if (requiresCleanupOnlyCommittedPromptRecovery(runtime)) {
    throw new BrowserAutomationError(
      "Browser answer reattach is unavailable because the remaining follow-up prompt queue was not durably persisted; exact abort cleanup is required.",
      {
        stage: "prompt-epoch",
        code: "committed-prompt-identity-mismatch",
        reattachClassification: "cleanup-only-abort",
        remainingFollowUps: runtime.promptEpoch?.remainingFollowUps,
        runtime,
      },
    );
  }
  const locator = resolveCommittedPromptEpochLocator(runtime);
  if (!locator) {
    throw new BrowserAutomationError(
      "Browser reattach requires a structurally valid committed prompt epoch.",
      { stage: "prompt-epoch", code: "committed-prompt-identity-mismatch" },
    );
  }
  return locator;
}

export function assertSameCommittedPromptEpoch(
  expected: CommittedPromptEpochLocator,
  actual: CommittedPromptEpochLocator,
): void {
  if (
    expected.epoch.epochId !== actual.epoch.epochId ||
    expected.promptSha256 !== actual.promptSha256 ||
    expected.conversationId !== actual.conversationId ||
    expected.verifiedUserTurnIndex !== actual.verifiedUserTurnIndex ||
    expected.verifiedUserTurnId !== actual.verifiedUserTurnId ||
    expected.verifiedUserMessageId !== actual.verifiedUserMessageId ||
    expected.epoch.baselineTurns !== actual.epoch.baselineTurns ||
    expected.epoch.followUpOrdinal !== actual.epoch.followUpOrdinal ||
    expected.epoch.remainingFollowUps !== actual.epoch.remainingFollowUps
  ) {
    throw new BrowserAutomationError(
      "Recovered browser runtime does not match the committed prompt epoch.",
      { stage: "prompt-epoch", code: "committed-prompt-identity-mismatch" },
    );
  }
}

export function hasRecoverableChatGptConversation(
  runtime: BrowserRuntimeMetadata | null | undefined,
): boolean {
  const locator = resolveCommittedPromptEpochLocator(runtime);
  return locator !== null && locator.epoch.remainingFollowUps === 0;
}

function isGeminiRecoveryTabUrl(candidate: string | undefined): boolean {
  if (candidate === undefined) return true;
  const trimmed = candidate.trim();
  if (/^about:blank#oracle-acquisition=[^#\s]+$/u.test(trimmed)) return true;
  try {
    const url = new URL(trimmed);
    return (
      url.protocol === "https:" &&
      !url.port &&
      url.hostname === "gemini.google.com" &&
      (url.pathname === "/app" || url.pathname.startsWith("/app/"))
    );
  } catch {
    return false;
  }
}

function sameCommittedPromptEpoch(
  expected: CommittedBrowserPromptEpoch,
  candidate: BrowserRuntimeMetadata["promptEpoch"],
): boolean {
  return (
    candidate?.status === "committed" &&
    candidate.epochId === expected.epochId &&
    candidate.promptSha256 === expected.promptSha256 &&
    candidate.baselineTurns === expected.baselineTurns &&
    candidate.followUpOrdinal === expected.followUpOrdinal &&
    candidate.remainingFollowUps === expected.remainingFollowUps &&
    candidate.verifiedUserTurnIndex === expected.verifiedUserTurnIndex &&
    candidate.verifiedUserTurnId === expected.verifiedUserTurnId &&
    candidate.verifiedUserMessageId === expected.verifiedUserMessageId &&
    candidate.conversationId === expected.conversationId
  );
}

export function resolveCommittedGeminiPromptEpochLocator(
  runtime: BrowserRuntimeMetadata | null | undefined,
  config: BrowserSessionConfig | null | undefined,
): CommittedPromptEpochLocator | null {
  if (
    !runtime ||
    resolveGeminiWebModel(config?.desiredModel) !== "gemini-3-pro-deep-think" ||
    !isGeminiRecoveryTabUrl(runtime.tabUrl)
  ) {
    return null;
  }

  const runtimeWithoutTabUrl: BrowserRuntimeMetadata = { ...runtime };
  delete runtimeWithoutTabUrl.tabUrl;
  const locator = resolveCommittedPromptEpochLocator(runtimeWithoutTabUrl);
  if (
    !locator ||
    locator.epoch.remainingFollowUps !== 0 ||
    !hasImmutableGeminiPromptIdentity(locator.epoch)
  ) {
    return null;
  }

  const targetId = runtime.chromeTargetId?.trim();
  if (!targetId || locator.conversationId !== targetId) return null;

  let boundOwnedTarget = false;
  for (const resource of runtime.recoveryCleanupResources ?? []) {
    const resourceTargetId = resource.chromeTargetId?.trim();
    if (resourceTargetId && resourceTargetId !== targetId) return null;
    if (resource.conversationId !== undefined && resource.conversationId !== targetId) return null;
    if (resource.promptEpoch && !sameCommittedPromptEpoch(locator.epoch, resource.promptEpoch)) {
      return null;
    }
    if (!resource.recoveryCleanup.ownsTarget) continue;
    if (boundOwnedTarget) return null;

    const acquisitionGeneration = resource.acquisition?.generationId?.trim();
    const capability = resource.targetCloseCapability;
    const acquisitionMarker = acquisitionGeneration
      ? `about:blank#oracle-acquisition=${acquisitionGeneration}`
      : undefined;
    const lease = resource.tabLease;
    if (
      resourceTargetId !== targetId ||
      !acquisitionMarker ||
      resource.acquisition?.targetMarkerUrl !== acquisitionMarker ||
      (runtime.tabUrl?.startsWith("about:blank#oracle-acquisition=") &&
        runtime.tabUrl !== acquisitionMarker) ||
      !capability ||
      capability.version !== 1 ||
      capability.targetId !== targetId ||
      capability.generationId !== acquisitionGeneration ||
      !capability.capabilityId.trim() ||
      !lease ||
      !lease.id.trim() ||
      lease.generationId !== acquisitionGeneration ||
      !resource.promptEpoch
    ) {
      return null;
    }
    boundOwnedTarget = true;
  }
  return boundOwnedTarget ? locator : null;
}

export function hasRecoverableGeminiConversation(
  runtime: BrowserRuntimeMetadata | null | undefined,
  config: BrowserSessionConfig | null | undefined,
): boolean {
  return resolveCommittedGeminiPromptEpochLocator(runtime, config) !== null;
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
