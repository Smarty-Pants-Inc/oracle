export { runBrowserMode } from "./browserCoordinator.js";
export { __test__ } from "./localBrowserCoordinator.js";

export type {
  BrowserAutomationConfig,
  BrowserRunOptions,
  BrowserRunResult,
  BrowserRunTransaction,
} from "./types.js";
export { CHATGPT_URL, DEFAULT_MODEL_STRATEGY, DEFAULT_MODEL_TARGET } from "./constants.js";
export {
  parseDuration,
  delay,
  estimateTokenCount,
  normalizeChatgptUrl,
  isTemporaryChatUrl,
} from "./utils.js";
export {
  formatThinkingLog,
  formatThinkingWaitingLog,
  buildThinkingStatusExpressionForTest,
  readThinkingStatusForTest,
  sanitizeThinkingText,
  startThinkingStatusMonitorForTest,
} from "./actions/thinkingStatus.js";
export {
  redactBrowserConfigForDebugLogForTest,
  shouldPreserveBrowserOnErrorForTest,
  classifyPreservedBrowserErrorForTest,
} from "./coordinatorPolicy.js";
export {
  formatBrowserTurnTranscript,
  isImageOnlyUiChromeText,
  isWebSocketClosureError,
  type BrowserConversationTurn,
} from "./responseCaptureCoordinator.js";
export {
  maybeArchiveCompletedConversationForTest,
  maybeArchiveInterruptedConversationForTest,
} from "./archiveSettlementCoordinator.js";
export {
  isLocalChromeHostForTest,
  resolveRemoteTabLeaseProfileDirForTest,
  runSubmissionWithRecoveryForTest,
} from "./promptSubmissionCoordinator.js";
export { shouldPreferSystemTmpDirForTest } from "./localExecutionContext.js";
export { resolveBrowserConfig, DEFAULT_BROWSER_CONFIG } from "./config.js";
export { syncCookies } from "./cookies.js";
export {
  navigateToChatGPT,
  ensureNotBlocked,
  ensurePromptReady,
  ensureModelSelection,
  submitPrompt,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
} from "./pageActions.js";
