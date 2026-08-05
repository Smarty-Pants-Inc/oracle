import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import type { resumeRemoteBrowserTransaction } from "../remote/client.js";
import type {
  captureAssistantMarkdown,
  verifyCommittedPromptTurn,
  waitForAssistantResponse,
  waitForResumedConversationHydration,
} from "./pageActions.js";
import type { waitForDeepResearchCompletion } from "./actions/deepResearch.js";
import type { connectToChromeTargetWithExactAuthority, launchChrome } from "./chromeLifecycle.js";
import type { acquireManualChromeOwner } from "./manualChromeOwner.js";
import type { acquireBrowserTabLease } from "./tabLeaseRegistry.js";
import type { ReattachRecoveryLock } from "./reattachLock.js";
import type { ReattachCleanupDeps, ReattachFinalizationResult } from "./reattachCleanup.js";
import type { TargetInfoLite } from "./reattachHelpers.js";
import type { ChromeClient } from "./types.js";

export interface ReattachCapture {
  answerText: string;
  answerMarkdown: string;
  runtime?: BrowserRuntimeMetadata;
  finalizeResources?: () => Promise<ReattachFinalizationResult>;
  abortResources?: () => Promise<ReattachFinalizationResult>;
}

export interface ReattachDeps {
  listTargets?: () => Promise<TargetInfoLite[]>;
  connect?: (options?: unknown) => Promise<ChromeClient>;
  waitForAssistantResponse?: typeof waitForAssistantResponse;
  captureAssistantMarkdown?: typeof captureAssistantMarkdown;
  waitForDeepResearchCompletion?: typeof waitForDeepResearchCompletion;
  waitForConversationHydration?: typeof waitForResumedConversationHydration;
  verifyCommittedPromptTurn?: typeof verifyCommittedPromptTurn;
  launchChrome?: typeof launchChrome;
  acquireBrowserTabLease?: typeof acquireBrowserTabLease;
  acquireManualChromeOwner?: typeof acquireManualChromeOwner;
  connectRecoveryTargetWithExactAuthority?: typeof connectToChromeTargetWithExactAuthority;
  recoverSession?: (
    runtime: BrowserRuntimeMetadata,
    config: BrowserSessionConfig | undefined,
  ) => Promise<ReattachCapture>;
  recoveryCleanup?: ReattachCleanupDeps;
  recoveryLockPath?: string;
  acquireRecoveryLock?: (lockPath: string) => Promise<ReattachRecoveryLock>;
  isRemotePublicationAcknowledged?: () => boolean;
  resumeRemoteBrowserTransaction?: typeof resumeRemoteBrowserTransaction;
  runtimeHintCb?: (runtime: BrowserRuntimeMetadata) => void | Promise<void>;
}

export interface ReattachResult {
  answerText: string;
  answerMarkdown: string;
  runtime: BrowserRuntimeMetadata;
  bindSettlement: (mode: "finalize" | "abort") => Promise<BrowserRuntimeMetadata>;
  finalize: () => Promise<ReattachFinalizationResult>;
  abort: () => Promise<ReattachFinalizationResult>;
}
