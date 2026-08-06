import type { BrowserRecoveryTargetCloseCapabilityMetadata } from "../sessionManager.js";
import type { BrowserModelSelectionEvidence } from "../sessionStore.js";
import type { ConversationUrlMonitor } from "./conversationUrlMonitor.js";
import type { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserTabLease } from "./tabLeaseRegistry.js";
import type { BrowserRunResult } from "./types.js";
import type {
  BrowserLevelChromeClient,
  SessionBoundChromeClient,
} from "./chromeSessionTransport.js";
import type { PostCapturePendingWork } from "./publicationSettlementCoordinator.js";
import type { CapturedResultPublicationPhase } from "./capturedResultPublicationCoordinator.js";

export interface LocalBrowserRunState {
  lastTargetId: string | undefined;
  lastUrl: string | undefined;
  ownsTarget: boolean;
  isolatedTargetId: string | null;
  targetCloseCapability: BrowserRecoveryTargetCloseCapabilityMetadata | undefined;
  client: SessionBoundChromeClient | null;
  browserClient: BrowserLevelChromeClient | null;
  browserRuntime: SessionBoundChromeClient["Runtime"] | null;
  modelSelectionEvidence: BrowserModelSelectionEvidence | undefined;
  tabLease: BrowserTabLease | null;
  conversationUrlMonitor: ConversationUrlMonitor | null;
  publicationPhase: CapturedResultPublicationPhase;
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
    browserClient: null,
    browserRuntime: null,
    modelSelectionEvidence: undefined,
    tabLease,
    conversationUrlMonitor: null,
    publicationPhase: "capture-preparation",
    connectionClosedUnexpectedly: false,
    preserveBrowserOnError: false,
    disconnectAssessmentFailure: null,
    removeDialogHandler: null,
    publishableCapture: null,
    postCapturePendingWork: null,
    escapingFailure: undefined,
  };
}
