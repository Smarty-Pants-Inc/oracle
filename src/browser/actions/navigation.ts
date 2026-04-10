import type { ChromeClient, BrowserLogger } from "../types.js";
import { CLOUDFLARE_SCRIPT_SELECTOR, CLOUDFLARE_TITLE, INPUT_SELECTORS } from "../constants.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import { BrowserAutomationError } from "../../oracle/errors.js";

export function installJavaScriptDialogAutoDismissal(
  Page: ChromeClient["Page"],
  logger: BrowserLogger,
): () => void {
  type DialogEvent = { type?: string; message?: string };
  const pageAny = Page as unknown as {
    on?: (event: string, listener: (params: DialogEvent) => void) => void;
    off?: (event: string, listener: (params: DialogEvent) => void) => void;
    removeListener?: (event: string, listener: (params: DialogEvent) => void) => void;
    handleJavaScriptDialog?: (params: { accept: boolean; promptText?: string }) => Promise<void>;
  };

  if (typeof pageAny.on !== "function" || typeof pageAny.handleJavaScriptDialog !== "function") {
    return () => {};
  }

  const handler = async (params: DialogEvent) => {
    const type = typeof params?.type === "string" ? params.type : "unknown";
    const message = typeof params?.message === "string" ? params.message : "";
    logger(`[nav] dismissing JS dialog (${type})${message ? `: ${message.slice(0, 140)}` : ""}`);
    try {
      await pageAny.handleJavaScriptDialog?.({ accept: true, promptText: "" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger(`[nav] failed to dismiss JS dialog: ${msg}`);
    }
  };

  pageAny.on("javascriptDialogOpening", handler);
  return () => {
    try {
      pageAny.off?.("javascriptDialogOpening", handler);
    } catch {
      try {
        pageAny.removeListener?.("javascriptDialogOpening", handler);
      } catch {
        // ignore
      }
    }
  };
}

export async function navigateToChatGPT(
  Page: ChromeClient["Page"],
  Runtime: ChromeClient["Runtime"],
  url: string,
  logger: BrowserLogger,
) {
  logger(`Navigating to ${url}`);
  await Page.navigate({ url });
  await waitForDocumentReady(Runtime, 45_000);
}

export interface PromptReadyNavigationOptions {
  url: string;
  fallbackUrl?: string;
  timeoutMs: number;
  fallbackTimeoutMs?: number;
  headless: boolean;
  logger: BrowserLogger;
}

export interface PromptReadyNavigationDeps {
  navigateToChatGPT?: typeof navigateToChatGPT;
  ensureNotBlocked?: typeof ensureNotBlocked;
  ensurePromptReady?: typeof ensurePromptReady;
}

async function evaluateWithTimeout(
  Runtime: ChromeClient["Runtime"],
  params: Parameters<ChromeClient["Runtime"]["evaluate"]>[0],
  timeoutMs: number,
  message: string,
) {
  return await Promise.race([
    Runtime.evaluate(params),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
  ]);
}

async function dismissBlockingUi(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<boolean> {
  const outcome = await evaluateWithTimeout(
    Runtime,
    {
      expression: `(() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        if (!style) return false;
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
      };
      const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const labelFor = (el) => normalize(el?.textContent || el?.getAttribute?.('aria-label') || el?.getAttribute?.('title'));
      const buttonCandidates = (root) =>
        Array.from(root.querySelectorAll('button,[role="button"],a')).filter((el) => isVisible(el));

      const roots = [
        ...Array.from(document.querySelectorAll('[role="dialog"],dialog')),
        document.body,
      ].filter(Boolean);
      for (const root of roots) {
        const buttons = buttonCandidates(root);
        const close = buttons.find((el) => labelFor(el).includes('close'));
        if (close) {
          (close).click();
          return { dismissed: true, action: 'close' };
        }
        const okLike = buttons.find((el) => {
          const label = labelFor(el);
          return (
            label === 'ok' ||
            label === 'got it' ||
            label === 'dismiss' ||
            label === 'continue' ||
            label === 'back' ||
            label.includes('back to chatgpt') ||
            label.includes('go to chatgpt') ||
            label.includes('return') ||
            label.includes('take me')
          );
        });
        if (okLike) {
          (okLike).click();
          return { dismissed: true, action: 'confirm' };
        }
      }
      return { dismissed: false };
    })()`,
      returnByValue: true,
    },
    5_000,
    "Timed out while dismissing blocking UI",
  ).catch(() => null);
  const value = outcome?.result?.value as { dismissed?: boolean; action?: string } | undefined;
  if (value?.dismissed) {
    logger(`[nav] dismissed blocking UI (${value.action ?? "unknown"})`);
    return true;
  }
  return false;
}

function isPromptReadyTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /prompt textarea did not appear before timeout|timed out waiting for the prompt textarea/i.test(
    message,
  );
}

async function navigateAndEnsurePromptReady(
  Page: ChromeClient["Page"],
  Runtime: ChromeClient["Runtime"],
  options: {
    url: string;
    timeoutMs: number;
    headless: boolean;
    logger: BrowserLogger;
  },
  deps: Required<
    Pick<PromptReadyNavigationDeps, "navigateToChatGPT" | "ensureNotBlocked" | "ensurePromptReady">
  >,
): Promise<void> {
  const { url, timeoutMs, headless, logger } = options;
  const retryTimeoutMs = Math.max(timeoutMs, 45_000);
  const runAttempt = async (attemptTimeoutMs: number) => {
    await deps.navigateToChatGPT(Page, Runtime, url, logger);
    await deps.ensureNotBlocked(Runtime, headless, logger);
    await dismissBlockingUi(Runtime, logger).catch(() => false);
    await deps.ensurePromptReady(Runtime, attemptTimeoutMs, logger);
  };

  try {
    await runAttempt(timeoutMs);
  } catch (error) {
    if (!isPromptReadyTimeout(error)) {
      throw error;
    }
    logger(
      `[nav] prompt missing on ${url}; retrying the same page once with ${Math.round(retryTimeoutMs / 1000)}s timeout.`,
    );
    await runAttempt(retryTimeoutMs);
  }
}

export async function navigateToPromptReadyWithFallback(
  Page: ChromeClient["Page"],
  Runtime: ChromeClient["Runtime"],
  options: PromptReadyNavigationOptions,
  deps: PromptReadyNavigationDeps = {},
): Promise<{ usedFallback: boolean }> {
  const { url, fallbackUrl, timeoutMs, fallbackTimeoutMs, headless, logger } = options;
  const navigate = deps.navigateToChatGPT ?? navigateToChatGPT;
  const ensureBlocked = deps.ensureNotBlocked ?? ensureNotBlocked;
  const ensureReady = deps.ensurePromptReady ?? ensurePromptReady;

  try {
    await navigateAndEnsurePromptReady(
      Page,
      Runtime,
      {
        url,
        timeoutMs,
        headless,
        logger,
      },
      {
        navigateToChatGPT: navigate,
        ensureNotBlocked: ensureBlocked,
        ensurePromptReady: ensureReady,
      },
    );
    return { usedFallback: false };
  } catch (error) {
    if (!fallbackUrl || fallbackUrl === url) {
      throw error;
    }
    const fallbackTimeout = fallbackTimeoutMs ?? Math.max(timeoutMs * 2, 120_000);
    logger(
      `Prompt not ready after ${Math.round(timeoutMs / 1000)}s on ${url}; retrying ${fallbackUrl} with ${Math.round(fallbackTimeout / 1000)}s timeout.`,
    );
    await navigateAndEnsurePromptReady(
      Page,
      Runtime,
      {
        url: fallbackUrl,
        timeoutMs: fallbackTimeout,
        headless,
        logger,
      },
      {
        navigateToChatGPT: navigate,
        ensureNotBlocked: ensureBlocked,
        ensurePromptReady: ensureReady,
      },
    );
    return { usedFallback: true };
  }
}

export async function ensureNotBlocked(
  Runtime: ChromeClient["Runtime"],
  headless: boolean,
  logger: BrowserLogger,
) {
  if (await isCloudflareInterstitial(Runtime)) {
    const message = headless
      ? "Cloudflare challenge detected in headless mode. Re-run with --headful so you can solve the challenge."
      : "Cloudflare challenge detected. Complete the “Just a moment…” check in the open browser, then rerun.";
    logger("Cloudflare anti-bot page detected");
    throw new BrowserAutomationError(message, { stage: "cloudflare-challenge", headless });
  }
}

const LOGIN_CHECK_TIMEOUT_MS = 5_000;
const BACKEND_API_PROBE_ENDPOINTS = [
  "/backend-api/me",
  "/backend-api/models?iim=false&is_gizmo=false",
] as const;
const CLOUDFLARE_BACKEND_MARKERS = [
  "enable javascript and cookies to continue",
  "window._cf_chl_opt",
  "/cdn-cgi/challenge-platform/",
] as const;

type BackendApiProbeResult = {
  ok: boolean;
  challenged?: boolean;
  url?: string | null;
  status?: number;
  contentType?: string | null;
  challengeMarkers?: string[];
  bodySnippet?: string | null;
  error?: string | null;
};

export async function ensureLoggedIn(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  options: { appliedCookies?: number | null; remoteSession?: boolean } = {},
) {
  // Learned: ChatGPT can render the UI (project view) while auth silently failed.
  // A backend-api probe plus DOM login CTA check catches both cases.
  const outcome = await Runtime.evaluate({
    expression: buildLoginProbeExpression(LOGIN_CHECK_TIMEOUT_MS),
    awaitPromise: true,
    returnByValue: true,
  });
  const probe = normalizeLoginProbe(outcome.result?.value);
  if (probe.ok) {
    await ensureBackendApiReachable(Runtime, logger, { timeoutMs: LOGIN_CHECK_TIMEOUT_MS });
    logger(
      `Login check passed (status=${probe.status}, domLoginCta=${Boolean(probe.domLoginCta)})`,
    );
    return;
  }

  const accepted = await attemptWelcomeBackLogin(Runtime, logger);
  if (accepted) {
    // Learned: "Welcome back" account picker needs a click even when cookies are valid,
    // and the redirect can lag, so re-probe before failing hard.
    await delay(1500);
    const retryOutcome = await Runtime.evaluate({
      expression: buildLoginProbeExpression(LOGIN_CHECK_TIMEOUT_MS),
      awaitPromise: true,
      returnByValue: true,
    });
    const retryProbe = normalizeLoginProbe(retryOutcome.result?.value);
    if (retryProbe.ok) {
      logger("Login restored via Welcome back account picker");
      return;
    }
    logger(
      `Login retry after Welcome back failed (status=${retryProbe.status}, domLoginCta=${Boolean(
        retryProbe.domLoginCta,
      )})`,
    );
  }

  logger(
    `Login probe failed (status=${probe.status}, domLoginCta=${Boolean(probe.domLoginCta)}, onAuthPage=${Boolean(
      probe.onAuthPage,
    )}, url=${probe.pageUrl ?? "n/a"}, error=${probe.error ?? "none"})`,
  );

  const domLabel = probe.domLoginCta ? " Login button detected on page." : "";
  const cookieHint = options.remoteSession
    ? "The remote Chrome session is not signed into ChatGPT. Sign in there, then rerun."
    : (options.appliedCookies ?? 0) === 0
      ? "No ChatGPT cookies were applied; sign in to chatgpt.com in Chrome or pass inline cookies (--browser-inline-cookies[(-file)] / ORACLE_BROWSER_COOKIES_JSON)."
      : "ChatGPT login appears missing; open chatgpt.com in Chrome to refresh the session or provide inline cookies (--browser-inline-cookies[(-file)] / ORACLE_BROWSER_COOKIES_JSON).";

  throw new Error(`ChatGPT session not detected.${domLabel} ${cookieHint}`);
}

export async function ensureBackendApiReachable(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  options: { timeoutMs?: number; endpoints?: readonly string[] } = {},
): Promise<void> {
  const probe = await probeBackendApiHealth(Runtime, options);
  if (!probe.challenged) {
    return;
  }
  logger(
    `ChatGPT backend API probe hit a Cloudflare challenge (url=${probe.url ?? "unknown"}, status=${probe.status ?? 0})`,
  );
  throw new BrowserAutomationError(
    "ChatGPT backend API requests are being challenged by Cloudflare in this browser runtime, so Oracle cannot submit prompts or capture replies.",
    {
      stage: "cloudflare-backend-challenge",
      url: probe.url ?? null,
      status: probe.status ?? 0,
      contentType: probe.contentType ?? null,
      challengeMarkers: probe.challengeMarkers ?? [],
      bodySnippet: probe.bodySnippet ?? null,
    },
  );
}

async function probeBackendApiHealth(
  Runtime: ChromeClient["Runtime"],
  options: { timeoutMs?: number; endpoints?: readonly string[] } = {},
): Promise<BackendApiProbeResult> {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? LOGIN_CHECK_TIMEOUT_MS);
  const endpoints =
    options.endpoints && options.endpoints.length > 0
      ? [...options.endpoints]
      : [...BACKEND_API_PROBE_ENDPOINTS];
  const outcome = await Runtime.evaluate({
    expression: buildBackendApiProbeExpression(timeoutMs, endpoints),
    awaitPromise: true,
    returnByValue: true,
  });
  return normalizeBackendApiProbe(outcome.result?.value);
}

async function attemptWelcomeBackLogin(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<boolean> {
  const outcome = await Runtime.evaluate({
    expression: `(() => {
      // Learned: "Welcome back" shows as a modal with account chips; click the email chip.
      const TIMEOUT_MS = 30000;
      const getLabel = (node) =>
        (node?.textContent || node?.getAttribute?.('aria-label') || '').trim();
      const isAccount = (label) =>
        Boolean(label) &&
        label.includes('@') &&
        !/log in|sign up|create account|another account/i.test(label);
      const findAccount = () => {
        const candidates = Array.from(document.querySelectorAll('[role="button"],button,a'));
        return candidates.find((node) => isAccount(getLabel(node))) || null;
      };
      const clickAccount = () => {
        const account = findAccount();
        if (!account) return null;
        try {
          (account).click();
        } catch (_error) {
          return { clicked: false, reason: 'click-failed' };
        }
        return { clicked: true, label: getLabel(account) };
      };
      const immediate = clickAccount();
      if (immediate) {
        return immediate;
      }
      const root = document.documentElement || document.body;
      if (!root) {
        return { clicked: false, reason: 'no-root' };
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          observer.disconnect();
          resolve({ clicked: false, reason: 'timeout' });
        }, TIMEOUT_MS);
        const observer = new MutationObserver(() => {
          const result = clickAccount();
          if (result) {
            clearTimeout(timer);
            observer.disconnect();
            resolve(result);
          }
        });
        observer.observe(root, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (outcome.exceptionDetails) {
    const details = outcome.exceptionDetails;
    const description =
      (details.exception &&
        typeof details.exception.description === "string" &&
        details.exception.description) ||
      details.text ||
      "unknown error";
    logger(`Welcome back auto-select probe failed: ${description}`);
  }
  const result = outcome.result?.value as
    | { clicked?: boolean; reason?: string; label?: string }
    | undefined;
  if (!result) {
    logger("Welcome back auto-select probe returned no result.");
    return false;
  }
  if (result?.clicked) {
    logger(`Welcome back modal detected; selected account ${result.label ?? "(unknown)"}`);
    return true;
  }
  if (result?.reason && result.reason !== "timeout") {
    logger(`Welcome back modal present but auto-select failed (${result.reason}).`);
  }
  if (result?.reason === "timeout") {
    logger("Welcome back modal not detected after login probe failure.");
  }
  return false;
}

export async function ensurePromptReady(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
) {
  const ready = await waitForPrompt(Runtime, timeoutMs);
  if (!ready) {
    const authUrl = await currentUrl(Runtime);
    if (authUrl && isAuthLoginUrl(authUrl)) {
      // Learned: auth.openai.com/login can appear after cookies are copied; allow manual login window.
      logger("Auth login page detected; waiting for manual login to complete...");
      const extended = Math.min(Math.max(timeoutMs, 60_000), 20 * 60_000);
      const loggedIn = await waitForPrompt(Runtime, extended);
      if (loggedIn) {
        return;
      }
    }
    await logDomFailure(Runtime, logger, "prompt-textarea");
    throw new Error("Prompt textarea did not appear before timeout");
  }
}

async function waitForDocumentReady(Runtime: ChromeClient["Runtime"], timeoutMs: number) {
  const start = Date.now();
  let lastError: Error | null = null;
  while (Date.now() - start < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - start);
    if (remainingMs <= 0) {
      break;
    }
    try {
      const { result } = await evaluateWithTimeout(
        Runtime,
        {
          expression: `document.readyState`,
          returnByValue: true,
        },
        Math.min(5_000, remainingMs),
        "Timed out reading document.readyState",
      );
      if (result?.value === "complete" || result?.value === "interactive") {
        return;
      }
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await delay(100);
  }
  const reason = lastError ? `: ${lastError.message}` : "";
  throw new Error(`Page did not reach ready state in time${reason}`);
}

async function currentUrl(Runtime: ChromeClient["Runtime"]): Promise<string | null> {
  const { result } = await evaluateWithTimeout(
    Runtime,
    {
      expression: 'typeof location === "object" && location.href ? location.href : null',
      returnByValue: true,
    },
    5_000,
    "Timed out reading current location",
  );
  return typeof result?.value === "string" ? result.value : null;
}

function isAuthLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("auth.openai.com")) {
      return true;
    }
    return /^\/log-?in/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function waitForPrompt(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const { result } = await evaluateWithTimeout(
      Runtime,
      {
        expression: `(() => {
        const selectors = ${JSON.stringify(INPUT_SELECTORS)};
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (node && !node.hasAttribute('disabled')) {
            return true;
          }
        }
        return false;
      })()`,
        returnByValue: true,
      },
      Math.min(5_000, Math.max(1_000, remainingMs)),
      "Timed out waiting for the prompt textarea",
    );
    if (result?.value) {
      return true;
    }
    await delay(200);
  }
  return false;
}

async function isCloudflareInterstitial(Runtime: ChromeClient["Runtime"]): Promise<boolean> {
  const { result: titleResult } = await evaluateWithTimeout(
    Runtime,
    {
      expression: "document.title",
      returnByValue: true,
    },
    5_000,
    "Timed out reading document.title",
  );
  const title = typeof titleResult.value === "string" ? titleResult.value : "";
  const challengeTitle = CLOUDFLARE_TITLE.toLowerCase();
  if (title.toLowerCase().includes(challengeTitle)) {
    return true;
  }

  const { result } = await evaluateWithTimeout(
    Runtime,
    {
      expression: `Boolean(document.querySelector('${CLOUDFLARE_SCRIPT_SELECTOR}'))`,
      returnByValue: true,
    },
    5_000,
    "Timed out checking for Cloudflare interstitial markers",
  );
  return Boolean(result.value);
}

type LoginProbeResult = {
  ok: boolean;
  status: number;
  url?: string | null;
  redirected?: boolean;
  error?: string | null;
  pageUrl?: string | null;
  domLoginCta?: boolean;
  onAuthPage?: boolean;
};

function buildBackendApiProbeExpression(timeoutMs: number, endpoints: readonly string[]): string {
  return `(async () => {
    const endpoints = ${JSON.stringify(endpoints)};
    const markers = ${JSON.stringify(Array.from(CLOUDFLARE_BACKEND_MARKERS))};
    const classify = (text) => {
      const normalized = String(text || '').toLowerCase();
      return markers.filter((marker) => normalized.includes(String(marker).toLowerCase()));
    };

    for (const url of endpoints) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ${timeoutMs});
        try {
          const response = await fetch(url, {
            cache: 'no-store',
            credentials: 'include',
            signal: controller.signal,
          });
          const contentType = response.headers?.get?.('content-type') || null;
          const shouldReadBody =
            !response.ok || (typeof contentType === 'string' && contentType.toLowerCase().includes('text/html'));
          let bodyText = '';
          if (shouldReadBody) {
            try {
              bodyText = await response.text();
            } catch {
              bodyText = '';
            }
          }
          const matchedMarkers = classify(bodyText);
          if (matchedMarkers.length > 0) {
            return {
              ok: false,
              challenged: true,
              url,
              status: response.status || 0,
              contentType,
              challengeMarkers: matchedMarkers,
              bodySnippet: String(bodyText || '').slice(0, 600),
            };
          }
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        return {
          ok: false,
          challenged: false,
          url,
          error: error ? String(error) : 'unknown',
        };
      }
    }

    return { ok: true, challenged: false };
  })()`;
}

function buildLoginProbeExpression(timeoutMs: number): string {
  return `(async () => {
    // Learned: /backend-api/me is the most reliable "am I logged in" signal.
    // Some UIs render without a session; use DOM + network for a robust answer.
    const timer = setTimeout(() => {}, ${timeoutMs});
    const pageUrl = typeof location === 'object' && location?.href ? location.href : null;
    const onAuthPage =
      typeof location === 'object' &&
      typeof location.pathname === 'string' &&
      /^\\/(auth|login|signin)/i.test(location.pathname);

    const hasLoginCta = () => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            'a[href*="/auth/login"]',
            'a[href*="/auth/signin"]',
            'button[type="submit"]',
            'button[data-testid*="login"]',
            'button[data-testid*="log-in"]',
            'button[data-testid*="sign-in"]',
            'button[data-testid*="signin"]',
            'button',
            'a',
          ].join(','),
        ),
      );
      const textMatches = (text) => {
        if (!text) return false;
        const normalized = text.toLowerCase().trim();
        return ['log in', 'login', 'sign in', 'signin', 'continue with'].some((needle) =>
          normalized.startsWith(needle),
        );
      };
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        const label =
          node.textContent?.trim() ||
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          '';
        if (textMatches(label)) {
          return true;
        }
      }
      return false;
    };

    let status = 0;
    let error = null;
    try {
      if (typeof fetch === 'function') {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ${timeoutMs});
        try {
          // Credentials included so we see a 200 only when cookies are valid.
          const response = await fetch('/backend-api/me', {
            cache: 'no-store',
            credentials: 'include',
            signal: controller.signal,
          });
          status = response.status || 0;
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch (err) {
      error = err ? String(err) : 'unknown';
    }

    const domLoginCta = hasLoginCta();
    const loginSignals = domLoginCta || onAuthPage;
    clearTimeout(timer);
    return {
      ok: !loginSignals && (status === 0 || status === 200),
      status,
      redirected: false,
      url: pageUrl,
      pageUrl,
      domLoginCta,
      onAuthPage,
      error,
    };
  })()`;
}

function normalizeLoginProbe(raw: unknown): LoginProbeResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, status: 0 };
  }
  const value = raw as Record<string, unknown>;
  const statusRaw = value.status;
  const status =
    typeof statusRaw === "number"
      ? statusRaw
      : typeof statusRaw === "string" && !Number.isNaN(Number(statusRaw))
        ? Number(statusRaw)
        : 0;

  return {
    ok: Boolean(value.ok),
    status: Number.isFinite(status) ? (status as number) : 0,
    url: typeof value.url === "string" ? value.url : null,
    redirected: Boolean(value.redirected),
    error: typeof value.error === "string" ? value.error : null,
    pageUrl: typeof value.pageUrl === "string" ? value.pageUrl : null,
    domLoginCta: Boolean(value.domLoginCta),
    onAuthPage: Boolean(value.onAuthPage),
  };
}

function normalizeBackendApiProbe(raw: unknown): BackendApiProbeResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, challenged: false };
  }
  const value = raw as Record<string, unknown>;
  const statusRaw = value.status;
  const status =
    typeof statusRaw === "number"
      ? statusRaw
      : typeof statusRaw === "string" && !Number.isNaN(Number(statusRaw))
        ? Number(statusRaw)
        : 0;
  const challengeMarkersRaw = value.challengeMarkers;
  const challengeMarkers = Array.isArray(challengeMarkersRaw)
    ? challengeMarkersRaw.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    ok: Boolean(value.ok),
    challenged: Boolean(value.challenged),
    url: typeof value.url === "string" ? value.url : null,
    status: Number.isFinite(status) ? (status as number) : 0,
    contentType: typeof value.contentType === "string" ? value.contentType : null,
    challengeMarkers,
    bodySnippet: typeof value.bodySnippet === "string" ? value.bodySnippet : null,
    error: typeof value.error === "string" ? value.error : null,
  };
}
