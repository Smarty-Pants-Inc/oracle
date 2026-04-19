import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const DEFAULT_CDP_HOST = "127.0.0.1";
const DEFAULT_CDP_PORT = 9222;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface PlaywrightSupervisorConnectOptions {
  browserWSEndpoint?: string | null;
  host?: string;
  port?: number;
  timeoutMs?: number;
}

export interface PlaywrightSupervisorContextInfo {
  contextIndex: number;
  pageCount: number;
}

export interface PlaywrightSupervisorPageInfo {
  contextIndex: number;
  pageIndex: number;
  url: string;
  normalizedUrl?: string;
}

export interface PlaywrightSupervisorCaptureOptions {
  screenshotPath?: string;
  tracePath?: string;
  contextIndex?: number;
  pageIndex?: number;
  fullPage?: boolean;
}

export interface PlaywrightSupervisorCaptureResult {
  screenshotPath?: string;
  tracePath?: string;
  warnings: string[];
}

export interface PlaywrightSupervisorBridge {
  endpoint: string;
  browser: Browser;
  listContexts: () => PlaywrightSupervisorContextInfo[];
  listPages: () => PlaywrightSupervisorPageInfo[];
  captureArtifacts: (
    options: PlaywrightSupervisorCaptureOptions,
  ) => Promise<PlaywrightSupervisorCaptureResult>;
  close: () => Promise<void>;
}

function normalizePort(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CDP_PORT;
  }
  const normalized = Math.trunc(value as number);
  if (normalized <= 0 || normalized > 65535) {
    throw new Error(`Invalid CDP port: ${value}`);
  }
  return normalized;
}

export function normalizeSupervisorPageUrl(raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const pathname = parsed.pathname.replace(/\/+$/, "");
      parsed.pathname = pathname || "/";
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

export function resolvePlaywrightSupervisorEndpoint(
  options: PlaywrightSupervisorConnectOptions,
): string {
  const explicitWsEndpoint = options.browserWSEndpoint?.trim();
  if (explicitWsEndpoint) {
    return explicitWsEndpoint;
  }
  const host = options.host?.trim() || DEFAULT_CDP_HOST;
  const port = normalizePort(options.port);
  return `http://${host}:${port}`;
}

function pickContextAndPage(
  browser: Browser,
  options: Pick<PlaywrightSupervisorCaptureOptions, "contextIndex" | "pageIndex">,
): { context?: BrowserContext; page?: Page } {
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    return {};
  }

  const contextIndex =
    Number.isInteger(options.contextIndex) &&
    (options.contextIndex as number) >= 0 &&
    (options.contextIndex as number) < contexts.length
      ? (options.contextIndex as number)
      : 0;
  const context = contexts[contextIndex];
  const pages = context.pages();
  if (pages.length === 0) {
    return { context };
  }

  const pageIndex =
    Number.isInteger(options.pageIndex) &&
    (options.pageIndex as number) >= 0 &&
    (options.pageIndex as number) < pages.length
      ? (options.pageIndex as number)
      : 0;
  return { context, page: pages[pageIndex] };
}

export async function connectPlaywrightSupervisor(
  options: PlaywrightSupervisorConnectOptions,
): Promise<PlaywrightSupervisorBridge> {
  const endpoint = resolvePlaywrightSupervisorEndpoint(options);
  const browser = await chromium.connectOverCDP(endpoint, {
    isLocal: true,
    timeout: options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  });

  return {
    endpoint,
    browser,
    listContexts: () =>
      browser.contexts().map((context, contextIndex) => ({
        contextIndex,
        pageCount: context.pages().length,
      })),
    listPages: () =>
      browser.contexts().flatMap((context, contextIndex) =>
        context.pages().map((page, pageIndex) => {
          const url = page.url();
          return {
            contextIndex,
            pageIndex,
            url,
            normalizedUrl: normalizeSupervisorPageUrl(url),
          };
        }),
      ),
    captureArtifacts: async (artifactOptions) => {
      const result: PlaywrightSupervisorCaptureResult = { warnings: [] };
      const { context, page } = pickContextAndPage(browser, artifactOptions);
      const wantsTrace = Boolean(artifactOptions.tracePath);
      let traceStarted = false;

      if (wantsTrace) {
        if (!context) {
          result.warnings.push("Trace capture skipped: no browser context available.");
        } else {
          try {
            await context.tracing.start({
              screenshots: true,
              snapshots: true,
              sources: false,
            });
            traceStarted = true;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.warnings.push(`Trace capture skipped: ${message}`);
          }
        }
      }

      if (artifactOptions.screenshotPath) {
        if (!page) {
          result.warnings.push("Screenshot skipped: no page available.");
        } else {
          try {
            await page.screenshot({
              path: artifactOptions.screenshotPath,
              fullPage: artifactOptions.fullPage ?? false,
            });
            result.screenshotPath = artifactOptions.screenshotPath;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.warnings.push(`Screenshot skipped: ${message}`);
          }
        }
      }

      if (traceStarted && context && artifactOptions.tracePath) {
        try {
          await context.tracing.stop({ path: artifactOptions.tracePath });
          result.tracePath = artifactOptions.tracePath;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.warnings.push(`Trace finalize skipped: ${message}`);
        }
      }

      return result;
    },
    close: async () => {
      await browser.close();
    },
  };
}
