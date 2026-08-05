import type { BrowserRecoveryTargetCloseCapabilityMetadata } from "../sessionManager.js";
import type { BrowserModelSelectionEvidence } from "../sessionStore.js";
import type { ConversationUrlMonitor } from "./conversationUrlMonitor.js";
import type { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserTabLease } from "./tabLeaseRegistry.js";
import type { BrowserRunResult, ChromeClient } from "./types.js";
import type { PostCapturePendingWork } from "./publicationSettlementCoordinator.js";

export interface LocalBrowserRunState {
  lastTargetId: string | undefined;
  lastUrl: string | undefined;
  ownsTarget: boolean;
  isolatedTargetId: string | null;
  targetCloseCapability: BrowserRecoveryTargetCloseCapabilityMetadata | undefined;
  client: ChromeClient | null;
  browserRuntime: ChromeClient["Runtime"] | null;
  modelSelectionEvidence: BrowserModelSelectionEvidence | undefined;
  tabLease: BrowserTabLease | null;
  conversationUrlMonitor: ConversationUrlMonitor | null;
  runStatus: "attempted" | "complete";
  connectionClosedUnexpectedly: boolean;
  preserveBrowserOnError: boolean;
  disconnectAssessmentFailure: BrowserAutomationError | null;
  removeDialogHandler: (() => void) | null;
  publishableCapture: BrowserRunResult | null;
  postCapturePendingWork: PostCapturePendingWork | null;
  escapingFailure: unknown;
}

export function createLocalBrowserRunState(tabLease: BrowserTabLease | null): LocalBrowserRunState {
  return {
    lastTargetId: undefined,
    lastUrl: undefined,
    ownsTarget: true,
    isolatedTargetId: null,
    targetCloseCapability: undefined,
    client: null,
    browserRuntime: null,
    modelSelectionEvidence: undefined,
    tabLease,
    conversationUrlMonitor: null,
    runStatus: "attempted",
    connectionClosedUnexpectedly: false,
    preserveBrowserOnError: false,
    disconnectAssessmentFailure: null,
    removeDialogHandler: null,
    publishableCapture: null,
    postCapturePendingWork: null,
    escapingFailure: undefined,
  };
}
