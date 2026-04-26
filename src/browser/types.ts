import type CDP from "chrome-remote-interface";
import type Protocol from "devtools-protocol";
import type { BrowserDownloadedFile, BrowserRuntimeMetadata } from "../sessionStore.js";
import type { ThinkingTimeLevel } from "../oracle/types.js";

export type ChromeClient = Awaited<ReturnType<typeof CDP>>;
export type CookieParam = Protocol.Network.CookieParam;
export type BrowserModelStrategy = "select" | "current" | "ignore";
export type BrowserLauncher = "chrome" | "carbonyl";

export interface BrowserbaseViewport {
  width: number;
  height: number;
}

export interface BrowserbaseConfig {
  enabled?: boolean;
  apiKey?: string | null;
  projectId?: string | null;
  contextId?: string | null;
  persist?: boolean;
  keepAlive?: boolean;
  region?: string | null;
  timeoutMs?: number;
  proxies?: string[] | null;
  stealth?: boolean;
  captcha?: boolean;
  viewport?: BrowserbaseViewport | null;
}

export type BrowserLogger = ((message: string) => void) & {
  verbose?: boolean;
  sessionLog?: (message: string) => void;
  progress?: (update: BrowserProgressUpdate) => void | Promise<void>;
};

export type BrowserProgressStage =
  | "starting"
  | "browser-ready"
  | "thread-bound"
  | "prompt-committed"
  | "assistant-generating"
  | "assistant-completed"
  | "error";

export interface BrowserProgressUpdate {
  stage: BrowserProgressStage;
  message: string;
  runtime?: Partial<BrowserRuntimeMetadata>;
}

export async function reportBrowserProgress(
  logger: BrowserLogger | undefined,
  update: BrowserProgressUpdate,
): Promise<void> {
  if (!logger) {
    return;
  }
  logger.sessionLog?.(`[browser-progress:${update.stage}] ${update.message}`);
  try {
    await logger.progress?.(update);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.sessionLog?.(`[browser-progress:error] Failed to persist browser progress: ${message}`);
  }
}

export interface BrowserAttachment {
  path: string;
  displayPath: string;
  sizeBytes?: number;
}

export interface BrowserAutomationConfig {
  launcher?: BrowserLauncher;
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  attachRunning?: boolean;
  supervisorChatgptUrl?: string | null;
  url?: string;
  chatgptUrl?: string | null;
  timeoutMs?: number;
  debugPort?: number | null;
  inputTimeoutMs?: number;
  /** Delay before rechecking the conversation after an assistant timeout. */
  assistantRecheckDelayMs?: number;
  /** Time budget for the delayed recheck attempt. */
  assistantRecheckTimeoutMs?: number;
  /** Wait for an existing shared Chrome to appear before launching a new one. */
  reuseChromeWaitMs?: number;
  /** Max time to wait for a shared manual-login profile lock (serializes parallel runs). */
  profileLockTimeoutMs?: number;
  /** Delay before starting periodic auto-reattach attempts after a timeout. */
  autoReattachDelayMs?: number;
  /** Interval between auto-reattach attempts (0 disables). */
  autoReattachIntervalMs?: number;
  /** Time budget for each auto-reattach attempt. */
  autoReattachTimeoutMs?: number;
  cookieSync?: boolean;
  cookieNames?: string[] | null;
  cookieSyncWaitMs?: number;
  inlineCookies?: CookieParam[] | null;
  inlineCookiesSource?: string | null;
  headless?: boolean;
  keepBrowser?: boolean;
  hideWindow?: boolean;
  desiredModel?: string | null;
  modelStrategy?: BrowserModelStrategy;
  debug?: boolean;
  allowCookieErrors?: boolean;
  remoteChrome?: { host: string; port: number } | null;
  remoteChromeBrowserWSEndpoint?: string | null;
  remoteChromeProfileRoot?: string | null;
  browserbase?: BrowserbaseConfig | null;
  manualLogin?: boolean;
  manualLoginProfileDir?: string | null;
  manualLoginCookieSync?: boolean;
  /** Thinking time intensity level for Thinking/Pro models: light, standard, extended, heavy */
  thinkingTime?: ThinkingTimeLevel;
}

export interface BrowserRunOptions {
  prompt: string;
  attachments?: BrowserAttachment[];
  downloadsDir?: string;
  /**
   * Optional secondary submission to try if the initial prompt is rejected by ChatGPT
   * (e.g. inline file paste exceeds composer limits). Intended for auto inline->upload fallback.
   */
  fallbackSubmission?: { prompt: string; attachments: BrowserAttachment[] };
  config?: BrowserAutomationConfig;
  log?: BrowserLogger;
  heartbeatIntervalMs?: number;
  verbose?: boolean;
  /** Optional hook to persist runtime info (port/url/target) as soon as Chrome is ready. */
  runtimeHintCb?: (hint: BrowserRuntimeMetadata) => void | Promise<void>;
}

export interface BrowserRunResult {
  answerText: string;
  answerMarkdown: string;
  answerHtml?: string;
  downloads?: BrowserDownloadedFile[];
  tookMs: number;
  answerTokens: number;
  answerChars: number;
  browserTransport?: "cdp";
  chromePid?: number;
  chromePort?: number;
  chromeHost?: string;
  chromeBrowserWSEndpoint?: string;
  chromeProfileRoot?: string;
  userDataDir?: string;
  chromeTargetId?: string;
  tabUrl?: string;
  conversationId?: string;
  controllerPid?: number;
  browserProvider?: "browserbase";
  browserbaseSessionId?: string;
  browserbaseProjectId?: string;
  browserbaseContextId?: string;
  browserbaseDebugUrl?: string;
  browserbaseDebuggerFullscreenUrl?: string;
  browserbaseKeepAlive?: boolean;
}

export type ResolvedBrowserConfig = Required<
  Omit<
    BrowserAutomationConfig,
    | "launcher"
    | "chromeProfile"
    | "chromePath"
    | "chromeCookiePath"
    | "desiredModel"
    | "remoteChrome"
    | "remoteChromeBrowserWSEndpoint"
    | "remoteChromeProfileRoot"
    | "browserbase"
    | "thinkingTime"
    | "modelStrategy"
  >
> & {
  launcher: BrowserLauncher;
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  attachRunning?: boolean;
  desiredModel?: string | null;
  modelStrategy?: BrowserModelStrategy;
  thinkingTime?: ThinkingTimeLevel;
  debugPort?: number | null;
  inlineCookiesSource?: string | null;
  remoteChrome?: { host: string; port: number } | null;
  remoteChromeBrowserWSEndpoint?: string | null;
  remoteChromeProfileRoot?: string | null;
  browserbase?: BrowserbaseConfig | null;
  manualLogin?: boolean;
  manualLoginProfileDir?: string | null;
  manualLoginCookieSync?: boolean;
};
