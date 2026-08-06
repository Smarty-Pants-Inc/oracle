import { randomUUID } from "node:crypto";
import type { BrowserModelSelectionEvidence, BrowserRuntimeMetadata } from "../sessionStore.js";
import type {
  BrowserRecoveryCleanupMetadata,
  BrowserRecoveryTargetCloseCapabilityMetadata,
} from "../sessionManager.js";
import type { BrowserAutomationError } from "../oracle/errors.js";
import type { ProfileDirectoryIdentity } from "./profileState.js";
import type { BrowserTabLease } from "./tabLeaseRegistry.js";
import type { ConversationUrlMonitor } from "./conversationUrlMonitor.js";
import {
  BrowserRunLifecycleController,
  type BrowserCaptureSettlementMode,
} from "./runLifecycle.js";
import type { ChromeDisconnectAssessment } from "./coordinatorPolicy.js";
import type { RemoteChromeConnection } from "./chromeLifecycle.js";
import {
  resolveRemoteTabLeaseProfileDir,
  shouldCloseOwnedRunTargetAfterRun,
} from "./promptSubmissionCoordinator.js";
import { normalizeBrowserFollowUpPrompts } from "./responseCaptureCoordinator.js";
import type { BrowserAcquisitionPendingResource } from "./archiveSettlementCoordinator.js";
import type { PostCapturePendingWork } from "./publicationSettlementCoordinator.js";
import { extractStableConversationIdFromUrl as extractConversationIdFromUrl } from "./conversationUrl.js";
import type {
  BrowserAttachment,
  BrowserCaptureFinalizationResult,
  BrowserLogger,
  BrowserRunOptions,
  BrowserRunResult,
  ChromeClient,
  ResolvedBrowserConfig,
} from "./types.js";

export type RemoteResourceSettler = (
  context: RemoteBrowserExecutionContext,
  mode: BrowserCaptureSettlementMode,
  pendingRuntime: BrowserRuntimeMetadata,
) => Promise<BrowserCaptureFinalizationResult>;

export interface RemoteBrowserExecutionContext {
  readonly promptText: string;
  readonly attachments: BrowserAttachment[];
  readonly config: ResolvedBrowserConfig;
  readonly logger: BrowserLogger;
  readonly options: BrowserRunOptions;
  readonly host: string;
  readonly port: number;
  readonly browserWSEndpoint: string | undefined;
  readonly chromeProfileRoot: string | undefined;
  readonly followUpPrompts: string[];
  readonly remoteLeaseProfileDir: string | null;
  readonly resourceOwnerId: string;
  readonly acquisitionGenerationId: string;
  readonly acquisitionLeaseId: string;
  readonly acquisitionTargetMarkerUrl: string;
  readonly startedAt: number;
  readonly lifecycle: BrowserRunLifecycleController;
  readonly disconnectPromise: Promise<never>;
  client: ChromeClient | null;
  browserRuntime: ChromeClient["Runtime"] | null;
  remoteTargetId: string | null;
  targetCloseCapability: BrowserRecoveryTargetCloseCapabilityMetadata | null;
  tabLease: BrowserTabLease | null;
  lastUrl: string | undefined;
  modelSelectionEvidence: BrowserModelSelectionEvidence | undefined;
  attachedExistingTab: boolean;
  ownsTarget: boolean;
  conversationUrlMonitor: ConversationUrlMonitor | null;
  remoteLeaseProfileIdentity: ProfileDirectoryIdentity | undefined;
  publishableCapture: BrowserRunResult | null;
  postCapturePendingWork: PostCapturePendingWork | null;
  retainRemoteConnectionForSettlement: boolean;
  connectionClosedUnexpectedly: boolean;
  runStatus: "attempted" | "complete";
  preserveBrowserOnError: boolean;
  stopThinkingMonitor: (() => void) | null;
  removeDialogHandler: (() => void) | null;
  connection: RemoteChromeConnection | null;
  disconnectAssessmentPromise: Promise<ChromeDisconnectAssessment> | null;
  disconnectAssessmentFailure: BrowserAutomationError | null;
  rejectDisconnect: (reason?: unknown) => void;
  closedRemoteTargetId: string | null;
  closedRemoteTargetCloseCapability: BrowserRecoveryTargetCloseCapabilityMetadata | null;
  releasedRemoteTabLeaseId: string | null;
  escapingFailure: unknown;
  buildRuntimeBase: (
    tabUrl?: string,
    pendingResource?: BrowserAcquisitionPendingResource,
  ) => BrowserRuntimeMetadata;
  buildRuntimeMetadata: (tabUrl?: string) => BrowserRuntimeMetadata;
  persistRuntime: (pendingResource?: BrowserAcquisitionPendingResource) => Promise<void>;
  emitRuntimeHint: () => Promise<void>;
  rememberEscapingFailure: (error: Error) => Error;
}

export function createRemoteBrowserExecutionContext(
  promptText: string,
  attachments: BrowserAttachment[],
  config: ResolvedBrowserConfig,
  logger: BrowserLogger,
  options: BrowserRunOptions,
  settleResources: RemoteResourceSettler,
): RemoteBrowserExecutionContext {
  const remoteChromeConfig = config.remoteChrome;
  if (!remoteChromeConfig) {
    throw new Error(
      "Remote Chrome configuration missing. Pass --remote-chrome <host:port> to use this mode.",
    );
  }
  const { host, port } = remoteChromeConfig;
  logger(`Connecting to remote Chrome at ${host}:${port}`);

  const browserWSEndpoint = config.remoteChromeBrowserWSEndpoint ?? undefined;
  const chromeProfileRoot = config.remoteChromeProfileRoot ?? undefined;
  const followUpPrompts = normalizeBrowserFollowUpPrompts(options.followUpPrompts);
  const remoteLeaseProfileDir = config.browserTabRef
    ? null
    : resolveRemoteTabLeaseProfileDir(config);
  const acquisitionGenerationId = randomUUID();
  const resourceOwnerId = options.sessionId?.trim() || randomUUID();
  const acquisitionLeaseId = randomUUID();
  const acquisitionTargetMarkerUrl = `about:blank#oracle-acquisition=${acquisitionGenerationId}`;
  const runtimeHintCb = options.runtimeHintCb;
  let rejectDisconnect: (reason?: unknown) => void = () => undefined;
  const disconnectPromise = new Promise<never>((_, reject) => {
    rejectDisconnect = reject;
  });
  let context!: RemoteBrowserExecutionContext;

  const lifecycle = new BrowserRunLifecycleController({
    getRuntime: () => context.buildRuntimeBase(),
    persistRuntime: async (runtime) => {
      if (!runtimeHintCb) return;
      await runtimeHintCb(runtime, context.modelSelectionEvidence);
    },
    settleResources: (mode, pendingRuntime) => settleResources(context, mode, pendingRuntime),
    onPromptCommitted: () => {
      void context.conversationUrlMonitor?.schedule("post-submit", config.timeoutMs ?? 120_000);
    },
  });

  context = {
    promptText,
    attachments,
    config,
    logger,
    options,
    host,
    port,
    browserWSEndpoint,
    chromeProfileRoot,
    followUpPrompts,
    remoteLeaseProfileDir,
    resourceOwnerId,
    acquisitionGenerationId,
    acquisitionLeaseId,
    acquisitionTargetMarkerUrl,
    startedAt: Date.now(),
    lifecycle,
    disconnectPromise,
    client: null,
    browserRuntime: null,
    remoteTargetId: null,
    targetCloseCapability: null,
    tabLease: null,
    lastUrl: undefined,
    modelSelectionEvidence: undefined,
    attachedExistingTab: false,
    ownsTarget: false,
    conversationUrlMonitor: null,
    remoteLeaseProfileIdentity: undefined,
    publishableCapture: null,
    postCapturePendingWork: null,
    retainRemoteConnectionForSettlement: false,
    connectionClosedUnexpectedly: false,
    runStatus: "attempted",
    preserveBrowserOnError: false,
    stopThinkingMonitor: null,
    removeDialogHandler: null,
    connection: null,
    disconnectAssessmentPromise: null,
    disconnectAssessmentFailure: null,
    rejectDisconnect,
    closedRemoteTargetId: null,
    closedRemoteTargetCloseCapability: null,
    releasedRemoteTabLeaseId: null,
    escapingFailure: undefined,
    buildRuntimeBase: () => {
      throw new Error("Remote runtime context is not initialized");
    },
    buildRuntimeMetadata: () => {
      throw new Error("Remote runtime context is not initialized");
    },
    persistRuntime: async () => {
      throw new Error("Remote runtime context is not initialized");
    },
    emitRuntimeHint: async () => {
      throw new Error("Remote runtime context is not initialized");
    },
    rememberEscapingFailure: (error) => error,
  };

  function buildRemoteRecoveryCleanupMetadata(
    pendingResource?: BrowserAcquisitionPendingResource,
  ): BrowserRecoveryCleanupMetadata {
    const authorityOwnsTarget = context.ownsTarget || pendingResource === "chrome-target";
    return {
      ownsTarget: authorityOwnsTarget,
      profileKind: "none",
      keepBrowser: Boolean(config.keepBrowser),
      closeOwnedTargetOnComplete:
        pendingResource === "chrome-target"
          ? true
          : shouldCloseOwnedRunTargetAfterRun({
              runStatus: context.runStatus,
              ownsTarget: authorityOwnsTarget,
              keepBrowser: Boolean(config.keepBrowser),
              closeOwnedTabOnComplete: options.closeOwnedTabOnComplete,
              preserveForRecovery: context.preserveBrowserOnError,
            }),
    };
  }

  context.buildRuntimeBase = (
    tabUrl = context.lastUrl,
    pendingResource?: BrowserAcquisitionPendingResource,
  ): BrowserRuntimeMetadata => ({
    browserTransport: "cdp",
    chromePort: port,
    chromeHost: host,
    chromeBrowserWSEndpoint: browserWSEndpoint,
    chromeProfileRoot,
    chromeTargetId: context.remoteTargetId ?? undefined,
    tabUrl,
    conversationId: tabUrl ? extractConversationIdFromUrl(tabUrl) : undefined,
    recoveryCleanupResources: [
      {
        chromePort: port,
        chromeHost: host,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeProfileRoot,
        profileDirectoryIdentity:
          context.tabLease?.profileDirectory ?? context.remoteLeaseProfileIdentity,
        userDataDir: remoteLeaseProfileDir ?? undefined,
        chromeTargetId: context.remoteTargetId ?? undefined,
        targetCloseCapability:
          context.ownsTarget && context.closedRemoteTargetId !== context.remoteTargetId
            ? (context.targetCloseCapability ?? undefined)
            : undefined,
        conversationId: tabUrl ? extractConversationIdFromUrl(tabUrl) : undefined,
        tabLease:
          remoteLeaseProfileDir && context.remoteLeaseProfileIdentity
            ? {
                generationId: context.tabLease?.generationId ?? acquisitionGenerationId,
                id: context.tabLease?.id ?? acquisitionLeaseId,
                profileDirectory:
                  context.tabLease?.profileDirectory ?? context.remoteLeaseProfileIdentity,
              }
            : undefined,
        acquisition: {
          generationId: acquisitionGenerationId,
          ...(pendingResource ? { pendingResource } : {}),
          ...(config.browserTabRef ? {} : { targetMarkerUrl: acquisitionTargetMarkerUrl }),
        },
        recoveryCleanup: buildRemoteRecoveryCleanupMetadata(pendingResource),
      },
    ],
    recoveryCleanupResult: { status: "pending" },
    controllerPid: process.pid,
  });
  context.buildRuntimeMetadata = (tabUrl = context.lastUrl): BrowserRuntimeMetadata =>
    lifecycle.runtime(context.buildRuntimeBase(tabUrl));
  context.persistRuntime = async (
    pendingResource?: BrowserAcquisitionPendingResource,
  ): Promise<void> => {
    if (!runtimeHintCb) return;
    await runtimeHintCb(
      pendingResource
        ? context.buildRuntimeBase(context.lastUrl, pendingResource)
        : context.buildRuntimeMetadata(),
      context.modelSelectionEvidence,
    );
  };
  context.emitRuntimeHint = async (): Promise<void> => {
    if (!runtimeHintCb) return;
    try {
      await runtimeHintCb(context.buildRuntimeMetadata(), context.modelSelectionEvidence);
      await context.tabLease?.update({
        chromeHost: host,
        chromePort: port,
        chromeTargetId: context.remoteTargetId ?? undefined,
        tabUrl: context.lastUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  context.rememberEscapingFailure = (error: Error): Error => {
    context.escapingFailure = error;
    return error;
  };

  return context;
}
