export type {
  BrowserAutomationConfig,
  BrowserRunOptions,
  BrowserRunResult,
} from "./browser/index.js";

export {
  runBrowserMode,
  CHATGPT_URL,
  DEFAULT_MODEL_STRATEGY,
  DEFAULT_MODEL_TARGET,
  parseDuration,
  isRootChatgptUrl,
  isSupervisorScopedChatgptUrl,
  normalizeChatgptUrl,
  normalizeProjectScopedChatgptUrl,
  isTemporaryChatUrl,
} from "./browser/index.js";
