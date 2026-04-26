import { CHATGPT_URL, DEFAULT_MODEL_STRATEGY, DEFAULT_MODEL_TARGET } from "./constants.js";
import { normalizeBrowserModelStrategy } from "./modelStrategy.js";
import type { BrowserAutomationConfig, ResolvedBrowserConfig } from "./types.js";
import { isTemporaryChatUrl, normalizeChatgptUrl } from "./utils.js";
import os from "node:os";
import path from "node:path";

export const DEFAULT_BROWSER_CONFIG: ResolvedBrowserConfig = {
  launcher: "chrome",
  chromeProfile: null,
  chromePath: null,
  chromeCookiePath: null,
  attachRunning: false,
  supervisorChatgptUrl: null,
  url: CHATGPT_URL,
  chatgptUrl: CHATGPT_URL,
  timeoutMs: 1_200_000,
  debugPort: null,
  inputTimeoutMs: 60_000,
  assistantRecheckDelayMs: 0,
  assistantRecheckTimeoutMs: 120_000,
  reuseChromeWaitMs: 10_000,
  profileLockTimeoutMs: 300_000,
  autoReattachDelayMs: 0,
  autoReattachIntervalMs: 0,
  autoReattachTimeoutMs: 120_000,
  cookieSync: true,
  cookieNames: null,
  cookieSyncWaitMs: 0,
  inlineCookies: null,
  inlineCookiesSource: null,
  headless: false,
  keepBrowser: false,
  hideWindow: false,
  desiredModel: DEFAULT_MODEL_TARGET,
  modelStrategy: DEFAULT_MODEL_STRATEGY,
  debug: false,
  allowCookieErrors: false,
  remoteChrome: null,
  remoteChromeBrowserWSEndpoint: null,
  remoteChromeProfileRoot: null,
  browserbase: null,
  manualLogin: false,
  manualLoginProfileDir: null,
  manualLoginCookieSync: false,
};

export function shouldPreferManagedLocalChromeDefaults(config: {
  launcher?: BrowserAutomationConfig["launcher"];
  attachRunning?: boolean;
  remoteChrome?: BrowserAutomationConfig["remoteChrome"];
  headless?: BrowserAutomationConfig["headless"];
}): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  if (config.launcher === "carbonyl" || config.attachRunning || config.remoteChrome) {
    return false;
  }
  return !(config.headless ?? DEFAULT_BROWSER_CONFIG.headless);
}

function allowVisibleChromeLaunchOverride(): boolean {
  const raw = (process.env.ORACLE_ALLOW_VISIBLE_CHROME ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function normalizeLocalChromeLaunchConfig<T extends ResolvedBrowserConfig>(config: T): T {
  if (allowVisibleChromeLaunchOverride() || !shouldPreferManagedLocalChromeDefaults(config)) {
    return config;
  }

  const nextConfig = {
    ...config,
    hideWindow: true,
    keepBrowser: config.keepBrowser || config.manualLogin,
  };
  return nextConfig as T;
}

export function resolveBrowserConfig(
  config: BrowserAutomationConfig | undefined,
): ResolvedBrowserConfig {
  const debugPortEnv = parseDebugPort(
    process.env.ORACLE_BROWSER_PORT ?? process.env.ORACLE_BROWSER_DEBUG_PORT,
  );
  const envAllowCookieErrors =
    (process.env.ORACLE_BROWSER_ALLOW_COOKIE_ERRORS ?? "").trim().toLowerCase() === "true" ||
    (process.env.ORACLE_BROWSER_ALLOW_COOKIE_ERRORS ?? "").trim() === "1";
  const rawUrl = config?.chatgptUrl ?? config?.url ?? DEFAULT_BROWSER_CONFIG.url;
  const normalizedUrl = normalizeChatgptUrl(
    rawUrl ?? DEFAULT_BROWSER_CONFIG.url,
    DEFAULT_BROWSER_CONFIG.url,
  );
  const desiredModel =
    config?.desiredModel ?? DEFAULT_BROWSER_CONFIG.desiredModel ?? DEFAULT_MODEL_TARGET;
  const modelStrategy =
    normalizeBrowserModelStrategy(config?.modelStrategy) ??
    DEFAULT_BROWSER_CONFIG.modelStrategy ??
    DEFAULT_MODEL_STRATEGY;
  if (
    modelStrategy === "select" &&
    isTemporaryChatUrl(normalizedUrl) &&
    /\bpro\b/i.test(desiredModel)
  ) {
    throw new Error(
      "Temporary Chat mode does not expose Pro models in the ChatGPT model picker. " +
        'Remove "temporary-chat=true" from your browser URL, or use a non-Pro model label (e.g. "GPT-5.2").',
    );
  }
  const isWindows = process.platform === "win32";
  const attachRunning = config?.attachRunning ?? DEFAULT_BROWSER_CONFIG.attachRunning;
  const cookieSyncDefault = isWindows ? false : DEFAULT_BROWSER_CONFIG.cookieSync;
  const explicitProfileDir =
    config?.manualLoginProfileDir ?? process.env.ORACLE_BROWSER_PROFILE_DIR ?? null;
  const resolvedProfileDir =
    explicitProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile");
  const launcher = config?.launcher ?? DEFAULT_BROWSER_CONFIG.launcher;
  const isCarbonyl = launcher === "carbonyl";
  const manualLogin = isCarbonyl
    ? false
    : (config?.manualLogin ?? (isWindows ? true : DEFAULT_BROWSER_CONFIG.manualLogin));
  return {
    ...DEFAULT_BROWSER_CONFIG,
    ...config,
    launcher,
    url: normalizedUrl,
    chatgptUrl: normalizedUrl,
    timeoutMs: config?.timeoutMs ?? DEFAULT_BROWSER_CONFIG.timeoutMs,
    debugPort: config?.debugPort ?? debugPortEnv ?? DEFAULT_BROWSER_CONFIG.debugPort,
    inputTimeoutMs: config?.inputTimeoutMs ?? DEFAULT_BROWSER_CONFIG.inputTimeoutMs,
    assistantRecheckDelayMs:
      config?.assistantRecheckDelayMs ?? DEFAULT_BROWSER_CONFIG.assistantRecheckDelayMs,
    assistantRecheckTimeoutMs:
      config?.assistantRecheckTimeoutMs ?? DEFAULT_BROWSER_CONFIG.assistantRecheckTimeoutMs,
    reuseChromeWaitMs: config?.reuseChromeWaitMs ?? DEFAULT_BROWSER_CONFIG.reuseChromeWaitMs,
    profileLockTimeoutMs:
      config?.profileLockTimeoutMs ?? DEFAULT_BROWSER_CONFIG.profileLockTimeoutMs,
    autoReattachDelayMs: config?.autoReattachDelayMs ?? DEFAULT_BROWSER_CONFIG.autoReattachDelayMs,
    autoReattachIntervalMs:
      config?.autoReattachIntervalMs ?? DEFAULT_BROWSER_CONFIG.autoReattachIntervalMs,
    autoReattachTimeoutMs:
      config?.autoReattachTimeoutMs ?? DEFAULT_BROWSER_CONFIG.autoReattachTimeoutMs,
    cookieSync: config?.cookieSync ?? cookieSyncDefault,
    cookieNames: config?.cookieNames ?? DEFAULT_BROWSER_CONFIG.cookieNames,
    cookieSyncWaitMs: config?.cookieSyncWaitMs ?? DEFAULT_BROWSER_CONFIG.cookieSyncWaitMs,
    inlineCookies: config?.inlineCookies ?? DEFAULT_BROWSER_CONFIG.inlineCookies,
    inlineCookiesSource: config?.inlineCookiesSource ?? DEFAULT_BROWSER_CONFIG.inlineCookiesSource,
    headless: isCarbonyl ? false : (config?.headless ?? DEFAULT_BROWSER_CONFIG.headless),
    keepBrowser: config?.keepBrowser ?? DEFAULT_BROWSER_CONFIG.keepBrowser,
    hideWindow: isCarbonyl ? false : (config?.hideWindow ?? DEFAULT_BROWSER_CONFIG.hideWindow),
    desiredModel,
    modelStrategy,
    chromeProfile: config?.chromeProfile ?? DEFAULT_BROWSER_CONFIG.chromeProfile,
    chromePath: config?.chromePath ?? DEFAULT_BROWSER_CONFIG.chromePath,
    chromeCookiePath: config?.chromeCookiePath ?? DEFAULT_BROWSER_CONFIG.chromeCookiePath,
    attachRunning,
    supervisorChatgptUrl:
      config?.supervisorChatgptUrl ?? DEFAULT_BROWSER_CONFIG.supervisorChatgptUrl,
    debug: config?.debug ?? DEFAULT_BROWSER_CONFIG.debug,
    allowCookieErrors:
      config?.allowCookieErrors ?? envAllowCookieErrors ?? DEFAULT_BROWSER_CONFIG.allowCookieErrors,
    remoteChromeBrowserWSEndpoint:
      config?.remoteChromeBrowserWSEndpoint ?? DEFAULT_BROWSER_CONFIG.remoteChromeBrowserWSEndpoint,
    remoteChromeProfileRoot:
      config?.remoteChromeProfileRoot ?? DEFAULT_BROWSER_CONFIG.remoteChromeProfileRoot,
    browserbase: resolveBrowserbaseConfig(config?.browserbase),
    thinkingTime: config?.thinkingTime,
    manualLogin,
    manualLoginProfileDir: isCarbonyl
      ? null
      : manualLogin || explicitProfileDir
        ? resolvedProfileDir
        : null,
    manualLoginCookieSync:
      config?.manualLoginCookieSync ?? DEFAULT_BROWSER_CONFIG.manualLoginCookieSync,
  };
}

function resolveBrowserbaseConfig(
  config: BrowserAutomationConfig["browserbase"] | undefined,
): ResolvedBrowserConfig["browserbase"] {
  const envConfig = readBrowserbaseEnvConfig();
  if (!config && !envConfig) return DEFAULT_BROWSER_CONFIG.browserbase;
  return compactBrowserbaseConfig({
    ...envConfig,
    ...config,
  });
}

function readBrowserbaseEnvConfig(): BrowserAutomationConfig["browserbase"] | undefined {
  const enabled = parseBooleanEnv(process.env.ORACLE_BROWSERBASE_ENABLED);
  const persist = parseBooleanEnv(process.env.ORACLE_BROWSERBASE_PERSIST);
  const keepAlive = parseBooleanEnv(process.env.ORACLE_BROWSERBASE_KEEP_ALIVE);
  const stealth = parseBooleanEnv(process.env.ORACLE_BROWSERBASE_STEALTH);
  const captcha = parseBooleanEnv(process.env.ORACLE_BROWSERBASE_CAPTCHA);
  const timeoutMs = parsePositiveIntEnv(process.env.ORACLE_BROWSERBASE_TIMEOUT_MS);
  const proxies = parseListEnv(process.env.ORACLE_BROWSERBASE_PROXIES);
  const viewport = parseViewportEnv(process.env.ORACLE_BROWSERBASE_VIEWPORT);
  const config = compactBrowserbaseConfig({
    enabled,
    apiKey: firstEnv("ORACLE_BROWSERBASE_API_KEY", "BROWSERBASE_API_KEY"),
    projectId: firstEnv("ORACLE_BROWSERBASE_PROJECT_ID", "BROWSERBASE_PROJECT_ID"),
    contextId: firstEnv("ORACLE_BROWSERBASE_CONTEXT_ID", "BROWSERBASE_CONTEXT_ID"),
    persist,
    keepAlive,
    region: firstEnv("ORACLE_BROWSERBASE_REGION", "BROWSERBASE_REGION"),
    timeoutMs,
    proxies,
    stealth,
    captcha,
    viewport,
  });
  return config ?? undefined;
}

function compactBrowserbaseConfig(
  config: BrowserAutomationConfig["browserbase"],
): BrowserAutomationConfig["browserbase"] | null {
  if (!config) return null;
  const next = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  ) as NonNullable<BrowserAutomationConfig["browserbase"]>;
  return Object.keys(next).length > 0 ? next : null;
}

function firstEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseBooleanEnv(raw?: string): boolean | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parsePositiveIntEnv(raw?: string): number | undefined {
  if (!raw?.trim()) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseListEnv(raw?: string): string[] | undefined {
  const values = raw
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values?.length ? values : undefined;
}

function parseViewportEnv(raw?: string): { width: number; height: number } | undefined {
  const match = raw?.trim().match(/^(\d+)x(\d+)$/i);
  if (!match) return undefined;
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return { width, height };
}

function parseDebugPort(raw?: string | null): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) {
    return null;
  }
  return value;
}
