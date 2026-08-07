import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir, release } from "node:os";
import path from "node:path";
import { getCookies, type Cookie } from "@steipete/sweet-cookie";
import { resolveBrowserConfig } from "../browser/config.js";
import { CHATGPT_URL } from "../browser/constants.js";
import {
  acquireManualChromeOwner,
  releaseManualChromeOwnerEndpointAuthority,
} from "../browser/manualChromeOwner.js";
import type { BrowserLogger, CookieParam } from "../browser/types.js";
import { delay } from "../browser/utils.js";
import { createRemoteServer } from "./serverController.js";
import type {
  RemoteServerInstance,
  RemoteServerLifecycle,
  RemoteServerOptions,
} from "./serverTypes.js";

export async function drainRemoteServerShutdown(
  server: Pick<RemoteServerInstance, "close">,
  shutdownRequested: Promise<void>,
  options: { logger?: (message: string) => void; retryDelayMs?: number } = {},
): Promise<void> {
  await shutdownRequested;
  const logger = options.logger ?? console.error;
  const retryDelayMs = options.retryDelayMs ?? 250;
  for (;;) {
    try {
      await server.close();
      return;
    } catch (error) {
      try {
        logger(
          `Failed to close remote server: ${error instanceof Error ? error.message : String(error)}. Retrying graceful shutdown.`,
        );
      } catch {
        // Cleanup authority must not depend on a writable diagnostic stream.
      }
      await delay(retryDelayMs);
    }
  }
}

interface RemoteManualChromeBootstrapDeps {
  acquireOwner?: typeof acquireManualChromeOwner;
  releaseOwnerEndpoint?: typeof releaseManualChromeOwnerEndpointAuthority;
}

export async function bootstrapRemoteManualChromeOwner(
  profileDir: string,
  logger: BrowserLogger,
  deps: RemoteManualChromeBootstrapDeps = {},
): Promise<void> {
  const owner = await (deps.acquireOwner ?? acquireManualChromeOwner)(
    profileDir,
    resolveBrowserConfig({
      manualLogin: true,
      manualLoginProfileDir: profileDir,
      manualLoginCookieSync: false,
      cookieSync: false,
      keepBrowser: true,
      url: CHATGPT_URL,
    }),
    logger,
    "remote-serve-bootstrap",
    { ownerPolicy: "service-persistent" },
  );
  try {
    logger(
      `${owner.source === "launched" ? "Launched" : "Reusing"} canonical manual-login Chrome owner on DevTools port ${owner.chrome.port} (pid ${owner.processIdentity.pid}).`,
    );
  } finally {
    await (deps.releaseOwnerEndpoint ?? releaseManualChromeOwnerEndpointAuthority)(owner);
  }
}

export async function ownRemoteServerLifecycle(
  server: RemoteServerInstance,
  lifecycle: RemoteServerLifecycle = {},
  options: {
    signalSource?: {
      on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
      off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    };
    logger?: (message: string) => void;
    retryDelayMs?: number;
  } = {},
): Promise<void> {
  const signalSource = options.signalSource ?? process;
  const logger = options.logger ?? console.error;
  const shutdownRequested = Promise.withResolvers<void>();
  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    shutdownRequested.resolve();
    try {
      console.log("Shutting down remote service...");
    } catch {
      // A closed output stream must not block graceful shutdown.
    }
  };
  signalSource.on("SIGINT", shutdown);
  signalSource.on("SIGTERM", shutdown);
  try {
    try {
      await lifecycle.onReady?.(server);
    } catch (error) {
      try {
        await server.close();
      } catch (closeError) {
        try {
          logger(
            `Remote service readiness failed and graceful close remains pending: ${closeError instanceof Error ? closeError.message : String(closeError)}. Retaining listener and controller authority until cleanup settles and shutdown is requested.`,
          );
        } catch {
          // Lifecycle ownership must not depend on a writable diagnostic stream.
        }
        await drainRemoteServerShutdown(server, shutdownRequested.promise, {
          logger,
          retryDelayMs: options.retryDelayMs,
        });
      }
      throw error;
    }
    await drainRemoteServerShutdown(server, shutdownRequested.promise, {
      logger,
      retryDelayMs: options.retryDelayMs,
    });
  } finally {
    signalSource.off("SIGINT", shutdown);
    signalSource.off("SIGTERM", shutdown);
  }
}

export async function serveRemote(
  options: RemoteServerOptions = {},
  lifecycle: RemoteServerLifecycle = {},
): Promise<void> {
  const manualProfileDir =
    options.manualLoginProfileDir ?? path.join(homedir(), ".oracle", "browser-profile");
  const preferManualLogin = options.manualLoginDefault || process.platform === "win32" || isWsl();
  let cookies: CookieParam[] | null = null;
  let opened = false;

  if (isWsl()) {
    console.log(
      "WSL detected. Run `oracle serve` from Windows PowerShell/Command Prompt so Oracle can prove private runtime ACL authority and use your Windows Chrome profile.",
    );
    console.log(
      "Alternatively, run Oracle on a native POSIX host; WSL cannot certify the backing Windows ACL for private browser and attachment storage.",
    );
    throw new Error(
      "Remote service not started: WSL cannot prove private runtime Windows ACL authority; use a native Windows or POSIX Oracle host.",
    );
  }

  if (!preferManualLogin) {
    // Warm-up: ensure this host has a ChatGPT login before accepting runs.
    const result = await loadLocalChatgptCookies(console.log, CHATGPT_URL);
    cookies = result.cookies;
    opened = result.opened;
  }

  if (!cookies || cookies.length === 0) {
    console.log("No ChatGPT cookies detected on this host.");
    if (preferManualLogin) {
      await mkdir(manualProfileDir, { recursive: true });
      console.log(
        `Cookie extraction is unavailable on this platform. Using manual-login Chrome profile at ${manualProfileDir}. Remote runs will reuse this profile; sign in once when the browser opens.`,
      );
      const bootstrapLogger = ((message?: string) => {
        if (typeof message === "string") console.log(message);
      }) as BrowserLogger;
      await bootstrapRemoteManualChromeOwner(manualProfileDir, bootstrapLogger);
    } else if (opened) {
      console.log(
        "Opened chatgpt.com for login. Sign in, then restart `oracle serve` to continue.",
      );
      throw new Error(
        "Remote service not started: ChatGPT login is required. Sign in, then restart oracle serve.",
      );
    } else {
      console.log(
        "Please open https://chatgpt.com/ in this host's browser and sign in; then rerun.",
      );
      console.log(
        "Tip: install xdg-utils (xdg-open) to enable automatic browser opening on Linux/WSL.",
      );
      throw new Error(
        "Remote service not started: no ChatGPT login was found and the login page could not be opened.",
      );
    }
  } else {
    console.log(
      `Detected ${cookies.length} ChatGPT cookies on this host; runs will reuse this session.`,
    );
  }

  const server = await createRemoteServer({
    ...options,
    manualLoginDefault: preferManualLogin,
    manualLoginProfileDir: manualProfileDir,
  });
  await ownRemoteServerLifecycle(server, lifecycle);
}

async function loadLocalChatgptCookies(
  logger: (message: string) => void,
  targetUrl: string,
): Promise<{ cookies: CookieParam[] | null; opened: boolean }> {
  try {
    logger("Loading ChatGPT cookies from this host's Chrome profile...");
    const { cookies: rawCookies, warnings } = await getCookies({
      url: targetUrl,
      browsers: ["chrome"],
      mode: "merge",
      chromeProfile: "Default",
      timeoutMs: 5_000,
    });
    if (warnings.length) {
      logger(`Cookie warnings:\n- ${warnings.join("\n- ")}`);
    }
    const cookies = rawCookies.map(toCdpCookie).filter((c): c is CookieParam => Boolean(c));
    if (!cookies || cookies.length === 0) {
      logger("No local ChatGPT cookies found on this host. Please log in once; opening ChatGPT...");
      const opened = triggerLocalLoginPrompt(logger, targetUrl);
      return { cookies: null, opened };
    }
    logger(`Loaded ${cookies.length} local ChatGPT cookies on this host.`);
    return { cookies, opened: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingDbMatch = message.match(/Unable to locate Chrome cookie DB at (.+?)(?:\.|$)/);
    if (missingDbMatch) {
      const lookedPath = missingDbMatch[1];
      logger(
        `Chrome cookies not found at ${lookedPath}. Set --browser-cookie-path to your Chrome profile or log in manually.`,
      );
    } else {
      logger(`Unable to load local ChatGPT cookies on this host: ${message}`);
    }
    if (process.platform === "linux" && isWsl()) {
      logger(
        "WSL hint: Chrome lives under /mnt/c/Users/<you>/AppData/Local/Google/Chrome/User Data/Default; pass --browser-cookie-path to that directory if auto-detect fails.",
      );
    }
    const opened = triggerLocalLoginPrompt(logger, targetUrl);
    return { cookies: null, opened };
  }
}

function toCdpCookie(cookie: Cookie): CookieParam | null {
  if (!cookie?.name) return null;
  const out: CookieParam = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? "/",
    secure: cookie.secure ?? true,
    httpOnly: cookie.httpOnly ?? false,
  };
  if (typeof cookie.expires === "number") out.expires = cookie.expires;
  if (cookie.sameSite === "Lax" || cookie.sameSite === "Strict" || cookie.sameSite === "None") {
    out.sameSite = cookie.sameSite;
  }
  return out;
}

function triggerLocalLoginPrompt(logger: (message: string) => void, url: string): boolean {
  const verbose = process.argv.includes("--verbose") || process.env.ORACLE_SERVE_VERBOSE === "1";
  const openers: Array<{ cmd: string; args?: string[] }> = [];

  if (process.platform === "darwin") {
    openers.push({ cmd: "open" });
  } else if (process.platform === "win32") {
    openers.push({ cmd: "start" });
  } else {
    if (isWsl()) {
      // Prefer wslview when available, then fall back to Windows start.exe to open in the host browser.
      openers.push({ cmd: "wslview" });
      openers.push({ cmd: "cmd.exe", args: ["/c", "start", "", url] });
    }
    openers.push({ cmd: "xdg-open" });
  }

  // Add a cross-platform, low-friction fallback when nothing above is available.
  openers.push({ cmd: "sensible-browser" });

  try {
    // Fire and forget; user completes login in the opened browser window.
    if (verbose) {
      logger(`[serve] Login opener candidates: ${openers.map((o) => o.cmd).join(", ")}`);
    }
    const candidate = openers.find((opener) => canSpawn(opener.cmd));
    if (candidate) {
      const child = spawn(candidate.cmd, candidate.args ?? [url], {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      child.once("error", (error) => {
        if (verbose) {
          logger(
            `[serve] Opener ${candidate.cmd} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        logger(`Please open ${url} in this host's browser and sign in; then rerun.`);
      });
      logger(
        `Opened ${url} locally via ${candidate.cmd}. Please sign in; subsequent runs will reuse the session.`,
      );
      if (verbose && candidate.args) {
        logger(`[serve] Opener args: ${candidate.args.join(" ")}`);
      }
      return true;
    }
    if (verbose) {
      logger("[serve] No available opener found; prompting manual login.");
    }
    return false;
  } catch {
    return false;
  }
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  return Boolean(process.env.WSL_DISTRO_NAME || release().toLowerCase().includes("microsoft"));
}

function canSpawn(cmd: string): boolean {
  if (!cmd) return false;
  try {
    if (process.platform === "win32") {
      // `where` returns non-zero when the command is not found.
      const result = spawnSync("where", [cmd], { stdio: "ignore" });
      return result.status === 0;
    }
    // `command -v` is a shell builtin; run through sh. Fallback to `which`.
    const shResult = spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    if (shResult.status === 0) return true;
    const whichResult = spawnSync("which", [cmd], { stdio: "ignore" });
    return whichResult.status === 0;
  } catch {
    return false;
  }
}
