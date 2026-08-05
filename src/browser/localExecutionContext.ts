import { mkdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ChromeLaunchResult } from "./chromeLifecycle.js";
import {
  defaultManualLoginProfileDir,
  formatManualLoginSetupCommand,
  resolveManualLoginWaitMs,
} from "./manualLoginProfile.js";
import { ensureLoggedIn } from "./pageActions.js";
import type { BrowserLogger, ChromeClient } from "./types.js";
import { delay } from "./utils.js";
// Local debug-port and login helpers.
export const DEFAULT_DEBUG_PORT = 9222;

export async function pickAvailableDebugPort(
  preferredPort: number,
  logger: BrowserLogger,
): Promise<number> {
  const start =
    Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : DEFAULT_DEBUG_PORT;
  for (let offset = 0; offset < 10; offset++) {
    const candidate = start + offset;
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  const fallback = await findEphemeralPort();
  logger(`DevTools ports ${start}-${start + 9} are occupied; falling back to ${fallback}.`);
  return fallback;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      server.close();
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to acquire ephemeral port")));
      }
    });
  });
}

export async function waitForLogin({
  runtime,
  logger,
  appliedCookies,
  manualLogin,
  failFastOnLoginCta,
  timeoutMs,
  profileDir,
  keepBrowser,
}: {
  runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  appliedCookies: number;
  manualLogin: boolean;
  failFastOnLoginCta?: boolean;
  timeoutMs: number;
  profileDir?: string;
  keepBrowser?: boolean;
}): Promise<void> {
  if (!manualLogin) {
    await ensureLoggedIn(runtime, logger, { appliedCookies });
    return;
  }
  const waitMs = resolveManualLoginWaitMs(timeoutMs, Boolean(keepBrowser));
  const deadline = Date.now() + waitMs;
  let lastNotice = 0;
  while (Date.now() < deadline) {
    try {
      await ensureLoggedIn(runtime, logger, { appliedCookies, failFastOnLoginCta });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const loginDetected = message?.toLowerCase().includes("login button");
      const sessionMissing = message?.toLowerCase().includes("session not detected");
      if (!loginDetected && !sessionMissing) {
        throw error;
      }
      const now = Date.now();
      if (now - lastNotice > 5000) {
        logger(
          "Manual login mode: please sign into chatgpt.com in the opened Chrome window; waiting for session to appear...",
        );
        lastNotice = now;
      }
      await delay(1000);
    }
  }
  const setupCommand = formatManualLoginSetupCommand(profileDir ?? defaultManualLoginProfileDir());
  throw new Error(
    "Manual login mode timed out waiting for ChatGPT session. " +
      `Browser mode is using Oracle's private Chrome profile at ${profileDir ?? "(default profile)"}, not your normal Chrome profile. ` +
      `Run first-time setup, sign in there, then retry: ${setupCommand}`,
  );
}

export function detachKeptChromeProcess(chrome: Pick<ChromeLaunchResult, "process">): void {
  try {
    chrome.process?.unref?.();
  } catch {
    // Best-effort only; cleanup should not mask the original browser result.
  }
}
// Platform-specific temporary directory helpers.
export function describeDevtoolsFirewallHint(host: string, port: number): string | null {
  if (!isWsl()) return null;
  return [
    `DevTools port ${host}:${port} is blocked from WSL.`,
    "",
    "PowerShell (admin):",
    `New-NetFirewallRule -DisplayName 'Chrome DevTools ${port}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port}`,
    "New-NetFirewallRule -DisplayName 'Chrome DevTools (chrome.exe)' -Direction Inbound -Action Allow -Program 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' -Protocol TCP",
    "",
    "Re-run the same oracle command after adding the rule.",
  ].join("\n");
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return os.release().toLowerCase().includes("microsoft");
}

export async function resolveUserDataBaseDir(): Promise<string> {
  // On WSL, Chrome launched via Windows can choke on UNC paths; prefer a Windows-backed temp folder.
  if (isWsl()) {
    const candidates = [
      "/mnt/c/Users/Public/AppData/Local/Temp",
      "/mnt/c/Temp",
      "/mnt/c/Windows/Temp",
    ];
    for (const candidate of candidates) {
      try {
        await mkdir(candidate, { recursive: true });
        return candidate;
      } catch {
        // try next
      }
    }
  }
  const tmpDir = os.tmpdir();
  if (shouldPreferSystemTmpDir(process.platform, tmpDir, os.homedir())) {
    try {
      await mkdir("/tmp", { recursive: true });
      return "/tmp";
    } catch {
      // Fall back to the inherited tmpdir if /tmp is unavailable.
    }
  }
  return tmpDir;
}

function shouldPreferSystemTmpDir(
  platform: NodeJS.Platform,
  tmpDir: string,
  homeDir: string,
): boolean {
  if (platform !== "linux" || !tmpDir || !homeDir) return false;
  const relativeToHome = path.relative(homeDir, tmpDir);
  if (!relativeToHome || relativeToHome.startsWith("..") || path.isAbsolute(relativeToHome)) {
    return false;
  }
  const firstSegment = relativeToHome.split(path.sep, 1)[0];
  return Boolean(firstSegment?.startsWith("."));
}

export function shouldPreferSystemTmpDirForTest(
  platform: NodeJS.Platform,
  tmpDir: string,
  homeDir: string,
): boolean {
  return shouldPreferSystemTmpDir(platform, tmpDir, homeDir);
}
