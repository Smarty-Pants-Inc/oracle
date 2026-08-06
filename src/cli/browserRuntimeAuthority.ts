import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import {
  hasExactPendingChromeAcquisitionAuthority,
  hasPendingChromeAcquisitionIntent,
  hasRecoverableChatGptConversation,
  hasRecoverableGeminiConversation,
  resolvePendingPromptEpochAuthority,
} from "../browser/reattachability.js";

type BrowserPromptEpoch = NonNullable<BrowserRuntimeMetadata["promptEpoch"]>;

/**
 * Keeps browser runtime authority monotonic across hints, terminal cleanup, and stale error
 * snapshots. Once an authority generation is settled, an error from that generation cannot
 * restore its cleanup capability.
 */
export class MonotonicBrowserRuntimeAuthority {
  private current: BrowserRuntimeMetadata | undefined;
  private readonly settledAuthorities = new Map<string, Set<string>>();
  private errorSupersededByTerminalCleanup = false;
  private readonly config: BrowserSessionConfig | undefined;

  constructor(initial: BrowserRuntimeMetadata | undefined, config?: BrowserSessionConfig) {
    this.current = initial;
    this.config = config;
  }

  observeHint(next: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
    return this.observe(next, "hint");
  }

  observeError(next: BrowserRuntimeMetadata | undefined): BrowserRuntimeMetadata | undefined {
    this.errorSupersededByTerminalCleanup = false;
    return next ? this.observe(next, "error") : this.current;
  }

  observeTerminal(next: BrowserRuntimeMetadata | undefined): BrowserRuntimeMetadata | undefined {
    this.errorSupersededByTerminalCleanup = false;
    return next ? this.observe(next, "terminal") : this.current;
  }

  didTerminalCleanupSupersedeError(): boolean {
    return this.errorSupersededByTerminalCleanup;
  }

  private observe(
    next: BrowserRuntimeMetadata,
    source: "hint" | "error" | "terminal",
  ): BrowserRuntimeMetadata {
    const current = this.current;
    if (!current) {
      this.current = next;
      return next;
    }

    const relation = comparePromptEpochs(current.promptEpoch, next.promptEpoch);
    if (relation === "older" || relation === "conflict") return current;
    if (relation === "newer") {
      this.current = next;
      return next;
    }

    const promptMerged = mergeCommittedPromptAuthority(current, next);
    if (!promptMerged) return current;
    const epochKey = promptEpochKey(promptMerged.promptEpoch ?? current.promptEpoch);
    const currentHasCleanup = hasCleanupAuthority(current);
    const nextHasCleanup = hasCleanupAuthority(promptMerged);

    if (epochKey && currentHasCleanup && !nextHasCleanup && source !== "error") {
      const settled = this.settledAuthorities.get(epochKey) ?? new Set<string>();
      for (const authority of recoveryAuthorityKeys(current)) settled.add(authority);
      this.settledAuthorities.set(epochKey, settled);
      this.current = promptMerged;
      return promptMerged;
    }

    const settled = epochKey ? this.settledAuthorities.get(epochKey) : undefined;
    if (
      settled?.size &&
      nextHasCleanup &&
      !hasNewRecoveryAuthority(promptMerged, settled, this.config)
    ) {
      if (source === "error") this.errorSupersededByTerminalCleanup = true;
      const retained = mergeWithoutCleanupRegression(current, promptMerged);
      this.current = retained;
      return retained;
    }

    if (source !== "error") {
      this.current = promptMerged;
      return promptMerged;
    }

    const selected = selectErrorRuntime(current, promptMerged, this.config);
    this.current = selected;
    return selected;
  }
}

export function retryableInitialBrowserRuntime(
  runtime: BrowserRuntimeMetadata | null | undefined,
  config?: BrowserSessionConfig,
): BrowserRuntimeMetadata | undefined {
  if (!runtime?.recoveryCleanupResources?.length || !runtime.recoveryCleanupResult) {
    return undefined;
  }
  if (hasPendingChromeAcquisitionIntent(runtime)) {
    return hasExactPendingChromeAcquisitionAuthority(runtime) ? runtime : undefined;
  }
  return !hasBrowserRecoveryAuthority(runtime, config) ||
    hasCoherentBrowserRecoveryAuthority(runtime, config)
    ? runtime
    : undefined;
}

export function hasRemoteRecoveryAuthority(
  runtime: BrowserRuntimeMetadata | null | undefined,
): boolean {
  return Boolean(runtime?.recoveryCleanupResources?.some((resource) => resource.remoteRecovery));
}

export function hasBrowserRecoveryAuthority(
  runtime: BrowserRuntimeMetadata | null | undefined,
  config?: BrowserSessionConfig,
): boolean {
  return (
    hasRemoteRecoveryAuthority(runtime) ||
    resolvePendingPromptEpochAuthority(runtime) !== null ||
    hasRecoverableChatGptConversation(runtime) ||
    hasRecoverableGeminiConversation(runtime, config)
  );
}

export function hasResumableBrowserAuthority(
  runtime: BrowserRuntimeMetadata | null | undefined,
  config?: BrowserSessionConfig,
): boolean {
  return (
    (hasRemoteRecoveryAuthority(runtime) && !runtime?.recoveryCleanupResult?.settlementMode) ||
    resolvePendingPromptEpochAuthority(runtime) !== null ||
    hasRecoverableChatGptConversation(runtime) ||
    hasRecoverableGeminiConversation(runtime, config)
  );
}

function comparePromptEpochs(
  current: BrowserPromptEpoch | undefined,
  candidate: BrowserPromptEpoch | undefined,
): "same" | "newer" | "older" | "conflict" {
  if (!current || !candidate) return "same";
  if (candidate.followUpOrdinal !== current.followUpOrdinal) {
    return candidate.followUpOrdinal > current.followUpOrdinal ? "newer" : "older";
  }
  if (promptEpochKey(current) !== promptEpochKey(candidate)) return "conflict";
  if (
    current.status === "committed" &&
    candidate.status === "committed" &&
    committedPromptIdentity(current) !== committedPromptIdentity(candidate)
  ) {
    return "conflict";
  }
  return "same";
}

function promptEpochKey(epoch: BrowserPromptEpoch | undefined): string | undefined {
  if (!epoch) return undefined;
  return JSON.stringify([epoch.epochId, epoch.promptSha256, epoch.followUpOrdinal]);
}

function committedPromptIdentity(
  epoch: Extract<BrowserPromptEpoch, { status: "committed" }>,
): string {
  return JSON.stringify([
    epoch.epochId,
    epoch.promptSha256,
    epoch.followUpOrdinal,
    epoch.conversationId,
    epoch.verifiedUserTurnIndex,
    epoch.verifiedUserTurnId,
    epoch.verifiedUserMessageId,
  ]);
}

function mergeCommittedPromptAuthority(
  current: BrowserRuntimeMetadata,
  candidate: BrowserRuntimeMetadata,
): BrowserRuntimeMetadata | null {
  const currentEpoch = current.promptEpoch;
  const candidateEpoch = candidate.promptEpoch;
  if (candidateEpoch?.status === "committed") {
    if (
      candidate.conversationId !== undefined &&
      candidate.conversationId !== candidateEpoch.conversationId
    ) {
      return null;
    }
    return {
      ...candidate,
      conversationId: candidate.conversationId ?? candidateEpoch.conversationId,
    };
  }
  if (currentEpoch?.status !== "committed") return candidate;
  return {
    ...candidate,
    promptEpoch: currentEpoch,
    conversationId: current.conversationId ?? currentEpoch.conversationId,
    ...(candidate.tabUrl === undefined && current.tabUrl !== undefined
      ? { tabUrl: current.tabUrl }
      : {}),
  };
}

function hasCleanupAuthority(runtime: BrowserRuntimeMetadata): boolean {
  return Boolean(runtime.recoveryCleanupResources?.length || runtime.recoveryCleanupResult);
}

function cleanupRank(runtime: BrowserRuntimeMetadata): number {
  return runtime.recoveryCleanupResult?.status === "failed"
    ? 2
    : hasCleanupAuthority(runtime)
      ? 1
      : 0;
}

function selectErrorRuntime(
  current: BrowserRuntimeMetadata,
  candidate: BrowserRuntimeMetadata,
  config?: BrowserSessionConfig,
): BrowserRuntimeMetadata {
  const currentAuthorities = new Set(recoveryAuthorityKeys(current));
  const candidateAuthorities = recoveryAuthorityKeys(candidate);
  const hasNewAuthority = candidateAuthorities.some(
    (authority) => !currentAuthorities.has(authority),
  );
  if (hasNewAuthority && hasCoherentBrowserRecoveryAuthority(candidate, config)) return candidate;

  const currentRank = cleanupRank(current);
  const candidateRank = cleanupRank(candidate);
  if (candidateRank > currentRank) return candidate;
  if (candidateRank < currentRank) return mergeWithoutCleanupRegression(current, candidate);

  const currentEpoch = current.promptEpoch;
  const candidateEpoch = candidate.promptEpoch;
  if (currentEpoch?.status !== "committed" && candidateEpoch?.status === "committed") {
    return candidate;
  }
  return mergeWithoutCleanupRegression(current, candidate);
}

function mergeWithoutCleanupRegression(
  current: BrowserRuntimeMetadata,
  candidate: BrowserRuntimeMetadata,
): BrowserRuntimeMetadata {
  const merged: BrowserRuntimeMetadata = {
    ...current,
    ...(candidate.browserTransport ? { browserTransport: candidate.browserTransport } : {}),
    ...(candidate.chromePid !== undefined ? { chromePid: candidate.chromePid } : {}),
    ...(candidate.chromeProcessIdentity
      ? { chromeProcessIdentity: candidate.chromeProcessIdentity }
      : {}),
    ...(candidate.chromePort !== undefined ? { chromePort: candidate.chromePort } : {}),
    ...(candidate.chromeHost ? { chromeHost: candidate.chromeHost } : {}),
    ...(candidate.chromeBrowserWSEndpoint
      ? { chromeBrowserWSEndpoint: candidate.chromeBrowserWSEndpoint }
      : {}),
    ...(candidate.chromeProfileRoot ? { chromeProfileRoot: candidate.chromeProfileRoot } : {}),
    ...(candidate.userDataDir ? { userDataDir: candidate.userDataDir } : {}),
    ...(candidate.chromeTargetId ? { chromeTargetId: candidate.chromeTargetId } : {}),
    ...(candidate.tabUrl ? { tabUrl: candidate.tabUrl } : {}),
    ...(candidate.conversationId ? { conversationId: candidate.conversationId } : {}),
    ...(candidate.promptEpoch ? { promptEpoch: candidate.promptEpoch } : {}),
    ...(candidate.controllerPid !== undefined ? { controllerPid: candidate.controllerPid } : {}),
  };
  if (current.recoveryCleanupResources) {
    merged.recoveryCleanupResources = current.recoveryCleanupResources;
  }
  if (current.recoveryCleanupResult) {
    merged.recoveryCleanupResult = current.recoveryCleanupResult;
  }
  return merged;
}

function hasNewRecoveryAuthority(
  runtime: BrowserRuntimeMetadata,
  settled: ReadonlySet<string>,
  config?: BrowserSessionConfig,
): boolean {
  return (
    hasCoherentBrowserRecoveryAuthority(runtime, config) &&
    recoveryAuthorityKeys(runtime).some((authority) => !settled.has(authority))
  );
}

function hasCoherentBrowserRecoveryAuthority(
  runtime: BrowserRuntimeMetadata,
  config?: BrowserSessionConfig,
): boolean {
  if (!hasBrowserRecoveryAuthority(runtime, config)) return false;
  const epoch = runtime.promptEpoch;
  const conversationId =
    epoch?.status === "committed" ? epoch.conversationId : runtime.conversationId;
  for (const resource of runtime.recoveryCleanupResources ?? []) {
    if (conversationId && resource.conversationId && resource.conversationId !== conversationId) {
      return false;
    }
    if (
      epoch &&
      resource.promptEpoch &&
      comparePromptEpochs(epoch, resource.promptEpoch) !== "same"
    ) {
      return false;
    }
  }
  return true;
}

function recoveryAuthorityKeys(runtime: BrowserRuntimeMetadata): string[] {
  const keys = new Set<string>();
  addTargetAuthorityKey(keys, runtime.chromeTargetId, runtime.conversationId);
  for (const resource of runtime.recoveryCleanupResources ?? []) {
    addTargetAuthorityKey(
      keys,
      resource.chromeTargetId,
      resource.conversationId ?? runtime.conversationId,
    );
    if (resource.remoteRecovery?.transactionToken) {
      keys.add(`remote:${resource.remoteRecovery.transactionToken}`);
    }
    if (resource.acquisition?.generationId) {
      keys.add(`generation:${resource.acquisition.generationId}`);
    }
    if (resource.tabLease?.id) keys.add(`lease:${resource.tabLease.id}`);
    if (resource.chromeProcessIdentity) {
      const identity = resource.chromeProcessIdentity;
      keys.add(
        `process:${identity.pid}:${identity.processStartTime}:${identity.launchNonce}:${identity.normalizedUserDataDir}`,
      );
    } else if (resource.chromePid !== undefined) {
      keys.add(`pid:${resource.chromePid}:${resource.userDataDir ?? ""}`);
    }
  }
  return [...keys];
}

function addTargetAuthorityKey(
  keys: Set<string>,
  targetId: string | undefined,
  conversationId: string | undefined,
): void {
  if (!targetId?.trim()) return;
  keys.add(`target:${targetId.trim()}:${conversationId?.trim() ?? ""}`);
}
