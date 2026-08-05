import path from "node:path";
import type {
  BrowserRecoveryCleanupResourceMetadata,
  BrowserRecoveryTargetCloseCapabilityMetadata,
} from "../sessionManager.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import {
  retainChromeEndpointAuthority,
  type ChromeLaunchResult,
  type RemoteChromeConnection,
  type RetainedChromeEndpointAuthority,
} from "./chromeLifecycle.js";
import {
  releaseManualChromeOwnerEndpointAuthority,
  type ManualChromeOwner,
} from "./manualChromeOwner.js";
import {
  sameChromeProcessIdentity,
  verifyProfileDirectoryIdentity,
  type ChromeOwnerDisposition,
  type ChromeProcessLaunchClaim,
  type ProfileDirectoryIdentity,
} from "./profileState.js";
import {
  finalizeRecoveredRuntime,
  pendingFinalization,
  type ReattachCleanupDeps,
  type ReattachFinalizationResult,
} from "./reattachCleanup.js";
import type { BrowserTabLease } from "./tabLeaseRegistry.js";
import type { BrowserLogger, ChromeClient } from "./types.js";

export interface ReattachFallbackAuthorityOptions {
  baseRuntime: BrowserRuntimeMetadata;
  userDataDir: string;
  profileIdentity: ProfileDirectoryIdentity;
  manualLogin: boolean;
  keepBrowser: boolean;
  generationId: string;
  launchClaim: ChromeProcessLaunchClaim;
  ownerDisposition: ChromeOwnerDisposition;
  leaseId: string;
  targetMarkerUrl: string;
  logger: BrowserLogger;
  runtimeHintCb?: (runtime: BrowserRuntimeMetadata) => void | Promise<void>;
  recoveryCleanup?: ReattachCleanupDeps;
}

export class ReattachFallbackAuthority {
  private readonly inheritedRecoveryCleanupResources: BrowserRecoveryCleanupResourceMetadata[];
  private manualChromeOwner: ManualChromeOwner | null = null;
  private fallbackLease: BrowserTabLease | null = null;
  private chrome: ChromeLaunchResult | null = null;
  private retainedOwnedChrome: ChromeLaunchResult | null = null;
  private fallbackTargetId: string | null = null;
  private fallbackTargetCloseCapability: BrowserRecoveryTargetCloseCapabilityMetadata | undefined;
  private fallbackRuntime: BrowserRuntimeMetadata | null = null;
  private client: ChromeClient | null = null;
  private closeFallbackConnection: (() => Promise<void>) | null = null;
  private completedFallbackCleanup: Extract<
    ReattachFinalizationResult,
    { status: "completed" }
  > | null = null;
  private manualOwnerEndpointReleased = false;

  constructor(private readonly options: ReattachFallbackAuthorityOptions) {
    this.inheritedRecoveryCleanupResources = [
      ...(options.baseRuntime.recoveryCleanupResources ?? []),
    ];
  }

  lease(): BrowserTabLease | null {
    return this.fallbackLease;
  }

  acquiredChrome(): ChromeLaunchResult {
    if (!this.chrome) throw new Error("Fallback Chrome acquisition is incomplete.");
    return this.chrome;
  }

  endpointAuthority(): RetainedChromeEndpointAuthority | undefined {
    return this.manualChromeOwner?.endpointAuthority ?? this.chrome?.endpointAuthority;
  }

  setLease(lease: BrowserTabLease): void {
    this.fallbackLease = lease;
  }

  setManualChromeOwner(owner: ManualChromeOwner): void {
    this.manualChromeOwner = owner;
    this.chrome = owner.chrome;
    if (owner.disposition === "close-on-last-lease") this.retainedOwnedChrome = owner.chrome;
  }

  setLaunchedChrome(chrome: ChromeLaunchResult): void {
    this.chrome = chrome;
    if (!this.options.keepBrowser) this.retainedOwnedChrome = chrome;
  }

  attachConnection(connection: RemoteChromeConnection): ChromeClient {
    this.client = connection.client;
    this.closeFallbackConnection = connection.close;
    return connection.client;
  }

  async disconnectConnection(): Promise<void> {
    if (this.closeFallbackConnection) {
      const close = this.closeFallbackConnection;
      this.closeFallbackConnection = null;
      await close().catch(() => undefined);
    } else {
      await this.client?.close().catch(() => undefined);
    }
    this.client = null;
  }

  async recordOwnedTarget(
    targetId: string,
    capability: BrowserRecoveryTargetCloseCapabilityMetadata,
  ): Promise<void> {
    this.fallbackTargetId = targetId;
    this.fallbackTargetCloseCapability = capability;
    await this.persist();
  }

  async clearOwnedTarget(targetId: string): Promise<void> {
    if (this.fallbackTargetId !== targetId) return;
    this.fallbackTargetId = null;
    this.fallbackTargetCloseCapability = undefined;
    await this.persist();
  }

  runtime(
    pendingResource?: "tab-lease" | "chrome-process" | "chrome-target",
  ): BrowserRuntimeMetadata {
    const { options } = this;
    const currentEndpointAuthority = this.endpointAuthority();
    const promptEpoch = options.baseRuntime.promptEpoch;
    const closesProcess = options.manualLogin
      ? this.manualChromeOwner?.disposition === "close-on-last-lease"
      : !options.keepBrowser;
    const ownsProcess = Boolean(this.chrome && closesProcess);
    const profileKind = options.manualLogin ? "manual-login" : "temporary";
    const ownsTarget = pendingResource === "chrome-target" || Boolean(this.fallbackTargetId);
    const resource: BrowserRecoveryCleanupResourceMetadata = {
      chromePid: this.chrome?.pid,
      chromeProcessIdentity: this.chrome?.processIdentity,
      profileDirectoryIdentity:
        this.chrome?.processIdentity?.profileDirectory ?? options.profileIdentity,
      chromePort: this.chrome?.port,
      chromeBrowserWSEndpoint: currentEndpointAuthority?.browserWSEndpoint,
      chromeHost: this.chrome?.host ?? "127.0.0.1",
      chromeProfileRoot: options.userDataDir,
      userDataDir: options.userDataDir,
      chromeTargetId: this.fallbackTargetId ?? undefined,
      targetCloseCapability: this.fallbackTargetId ? this.fallbackTargetCloseCapability : undefined,
      conversationId:
        promptEpoch?.status === "committed"
          ? promptEpoch.conversationId
          : options.baseRuntime.conversationId,
      promptEpoch,
      tabLease:
        this.fallbackLease || options.manualLogin
          ? {
              id: this.fallbackLease?.id ?? options.leaseId,
              profileDirectory: this.fallbackLease?.profileDirectory ?? options.profileIdentity,
            }
          : undefined,
      acquisition: {
        generationId: options.generationId,
        processOwnerProvenance: options.manualLogin ? "manual-canonical-owner" : "temporary-launch",
        processLaunchClaim: options.launchClaim,
        processOwnerDisposition: options.ownerDisposition,
        ...(pendingResource ? { pendingResource } : {}),
        targetMarkerUrl: options.targetMarkerUrl,
      },
      recoveryCleanup: {
        ownsTarget,
        profileKind,
        keepBrowser:
          pendingResource === "tab-lease" ||
          (options.manualLogin
            ? this.manualChromeOwner?.disposition === "preserve"
            : this.chrome
              ? !ownsProcess
              : options.keepBrowser),
        closeOwnedTargetOnComplete: ownsTarget,
      },
    };
    const next: BrowserRuntimeMetadata = {
      ...options.baseRuntime,
      browserTransport: "cdp",
      chromePid: this.chrome?.pid,
      chromeProcessIdentity: this.chrome?.processIdentity,
      chromePort: this.chrome?.port,
      chromeHost: this.chrome?.host ?? "127.0.0.1",
      chromeBrowserWSEndpoint: currentEndpointAuthority?.browserWSEndpoint,
      chromeProfileRoot: options.userDataDir,
      userDataDir: options.userDataDir,
      chromeTargetId: this.fallbackTargetId ?? undefined,
      recoveryCleanupResources: [...this.inheritedRecoveryCleanupResources, resource],
      recoveryCleanupResult: { status: "pending" },
      controllerPid: process.pid,
    };
    this.fallbackRuntime = next;
    return next;
  }

  async persist(
    pendingResource?: "tab-lease" | "chrome-process" | "chrome-target",
  ): Promise<BrowserRuntimeMetadata> {
    const next = this.runtime(pendingResource);
    await this.options.runtimeHintCb?.(next);
    return next;
  }

  async settle(mode: "finalize" | "abort"): Promise<ReattachFinalizationResult> {
    await this.disconnectConnection();
    const authorityRuntime = this.fallbackRuntime ?? this.runtime();
    const retainedChrome =
      this.retainedOwnedChrome ??
      (this.manualChromeOwner?.endpointAuthority ? this.manualChromeOwner.chrome : null);
    const fallbackExactTerminator = this.options.recoveryCleanup?.terminateExactChromeForProfile;
    const retainedEndpointAuthority =
      this.manualChromeOwner?.endpointAuthority ?? retainedChrome?.endpointAuthority;
    const cleanupEndpointAuthority =
      this.manualChromeOwner?.endpointAuthority === retainedEndpointAuthority &&
      retainedEndpointAuthority
        ? borrowEndpointAuthority(retainedEndpointAuthority)
        : retainedEndpointAuthority;
    const fallbackRetainEndpointAuthority =
      this.options.recoveryCleanup?.retainChromeEndpointAuthority ?? retainChromeEndpointAuthority;
    const cleanupDeps: ReattachCleanupDeps = retainedChrome
      ? {
          ...this.options.recoveryCleanup,
          retainChromeEndpointAuthority: cleanupEndpointAuthority
            ? async (options: Parameters<typeof retainChromeEndpointAuthority>[0]) => {
                if (
                  path.resolve(options.userDataDir) === path.resolve(this.options.userDataDir) &&
                  options.port === retainedChrome.port &&
                  options.host === (retainedChrome.host ?? "127.0.0.1") &&
                  sameChromeProcessIdentity(
                    options.processIdentity,
                    retainedChrome.processIdentity,
                  ) &&
                  (!options.browserWSEndpoint ||
                    options.browserWSEndpoint === cleanupEndpointAuthority.browserWSEndpoint)
                ) {
                  return cleanupEndpointAuthority;
                }
                return fallbackRetainEndpointAuthority(options);
              }
            : this.options.recoveryCleanup?.retainChromeEndpointAuthority,
          terminateExactChromeForProfile: cleanupEndpointAuthority
            ? fallbackExactTerminator
            : async (profileDir, serializedIdentity, cleanupLogger) => {
                if (path.resolve(profileDir) !== path.resolve(this.options.userDataDir)) {
                  if (fallbackExactTerminator) {
                    return fallbackExactTerminator(profileDir, serializedIdentity, cleanupLogger);
                  }
                  return {
                    status: "unsafe",
                    pid: serializedIdentity.pid,
                    reason:
                      "No exact Chrome teardown authority matches the retained launch profile",
                  };
                }
                if (
                  retainedChrome.pid !== retainedChrome.processIdentity.pid ||
                  !sameChromeProcessIdentity(serializedIdentity, retainedChrome.processIdentity)
                ) {
                  return {
                    status: "unsafe",
                    pid: serializedIdentity.pid,
                    reason: "Serialized Chrome process identity does not match the retained launch",
                  };
                }
                if (
                  !(await verifyProfileDirectoryIdentity(
                    profileDir,
                    retainedChrome.processIdentity.profileDirectory,
                  ))
                ) {
                  return {
                    status: "unsafe",
                    pid: serializedIdentity.pid,
                    reason: "Serialized Chrome profile identity does not match the retained launch",
                  };
                }
                try {
                  return await retainedChrome.kill();
                } catch (error) {
                  return {
                    status: "unsafe",
                    pid: retainedChrome.pid,
                    reason: error instanceof Error ? error.message : String(error),
                  };
                }
              },
        }
      : (this.options.recoveryCleanup ?? {});

    let completedCleanup = this.completedFallbackCleanup;
    if (!completedCleanup) {
      try {
        const cleanupResult = await finalizeRecoveredRuntime(
          authorityRuntime,
          this.options.logger,
          cleanupDeps,
          mode,
        );
        if (cleanupResult.status === "pending") return cleanupResult;
        completedCleanup = cleanupResult;
        this.completedFallbackCleanup = cleanupResult;
      } catch (error) {
        return pendingFinalization(
          authorityRuntime,
          error instanceof Error ? error.message : String(error),
          mode,
        );
      }
    }

    if (this.manualChromeOwner && !this.manualOwnerEndpointReleased) {
      try {
        await releaseManualChromeOwnerEndpointAuthority(this.manualChromeOwner);
        this.manualOwnerEndpointReleased = true;
      } catch (error) {
        return pendingFinalization(
          this.retainPendingEndpointReleaseRuntime(completedCleanup.runtime, authorityRuntime),
          `Exact Chrome endpoint release failed: ${error instanceof Error ? error.message : String(error)}`,
          mode,
        );
      }
    }
    return completedCleanup;
  }

  private retainPendingEndpointReleaseRuntime(
    completedRuntime: BrowserRuntimeMetadata,
    authorityRuntime: BrowserRuntimeMetadata,
  ): BrowserRuntimeMetadata {
    const resource = (authorityRuntime.recoveryCleanupResources ?? [])
      .toReversed()
      .find(
        (candidate) =>
          candidate.recoveryCleanup.profileKind === "manual-login" &&
          candidate.userDataDir &&
          path.resolve(candidate.userDataDir) === path.resolve(this.options.userDataDir),
      );
    if (!resource) return authorityRuntime;
    return {
      ...completedRuntime,
      chromeTargetId: undefined,
      recoveryCleanupResources: [
        {
          ...resource,
          chromeTargetId: undefined,
          targetCloseCapability: undefined,
          tabLease: undefined,
          recoveryCleanup: {
            ...resource.recoveryCleanup,
            ownsTarget: false,
            keepBrowser: true,
            closeOwnedTargetOnComplete: undefined,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
  }
}

function borrowEndpointAuthority(
  authority: RetainedChromeEndpointAuthority,
): RetainedChromeEndpointAuthority {
  if (!authority.runExactOperation) {
    return {
      browserWSEndpoint: authority.browserWSEndpoint,
      kill: authority.kill,
      release: async () => undefined,
    };
  }
  return {
    browserWSEndpoint: authority.browserWSEndpoint,
    kill: authority.kill,
    runExactOperation<T>(operation: (client: ChromeClient) => Promise<T>) {
      return authority.runExactOperation!(operation);
    },
    release: async () => undefined,
  };
}
