import path from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import type { ChromeProcessIdentity } from "../../src/browser/chromeProcessIdentity.js";
import type { ChromeProcessLaunchClaim } from "../../src/browser/chromeProcessLaunchClaim.js";
import {
  captureProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
} from "../../src/browser/profileState.js";
import type {
  ChromeLaunchResult,
  StableChromeProcessHandle,
} from "../../src/browser/chromeLifecycle.js";
import type { BrowserLogger } from "../../src/browser/types.js";
import { vi, type Mock } from "vitest";

export function createBrowserLogger(): BrowserLogger {
  return vi.fn<(message: string) => void>();
}

export const resolveLocalChromeLaunchRoute = () => ({
  connectHost: null,
  debugBindAddress: null,
  usePatchedLauncher: false,
});

export function syntheticProfileIdentity(userDataDir: string): ProfileDirectoryIdentity {
  const resolvedPath = path.resolve(userDataDir);
  const canonicalPath = existsSync(resolvedPath) ? realpathSync(resolvedPath) : resolvedPath;
  const physical = existsSync(canonicalPath) ? statSync(canonicalPath, { bigint: true }) : null;
  return {
    version: 2,
    platform: process.platform,
    canonicalPath,
    device: physical?.dev.toString() ?? "1",
    inode: physical?.ino.toString() ?? "2",
    birthtimeNs: physical?.birthtimeNs.toString() ?? "3",
  };
}

function executablePathForPlatform(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
  }
  return platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/google-chrome";
}

const TEST_LAUNCH_GENERATION_ID = "99999999-9999-4999-8999-999999999999";

function testLaunchClaim(nonce: string): ChromeProcessLaunchClaim {
  return { version: 1, generationId: TEST_LAUNCH_GENERATION_ID, nonce };
}

export function processIdentity(
  userDataDir: string,
  pid: number,
  launchNonce: string,
): ChromeProcessIdentity & { launchClaim: ChromeProcessLaunchClaim } {
  const profileDirectory = syntheticProfileIdentity(userDataDir);
  return {
    pid,
    processStartTime: `launch-${pid}`,
    executablePath: executablePathForPlatform(profileDirectory.platform),
    normalizedUserDataDir:
      profileDirectory.platform === "win32"
        ? profileDirectory.canonicalPath.toLowerCase()
        : profileDirectory.canonicalPath,
    launchNonce,
    launchClaim: testLaunchClaim(launchNonce),
    profileDirectory,
  };
}

export async function physicalProcessIdentity(
  userDataDir: string,
  pid: number,
  launchNonce: string,
): Promise<ChromeProcessIdentity> {
  const profileDirectory = await captureProfileDirectoryIdentity(userDataDir);
  return {
    pid,
    processStartTime: `launch-${pid}`,
    executablePath: executablePathForPlatform(profileDirectory.platform),
    normalizedUserDataDir:
      profileDirectory.platform === "win32"
        ? profileDirectory.canonicalPath.toLowerCase()
        : profileDirectory.canonicalPath,
    launchNonce,
    profileDirectory,
  };
}

export interface RetainedChildProcess extends StableChromeProcessHandle {
  signalCalls: NodeJS.Signals[];
  kill: Mock<(signal: NodeJS.Signals) => boolean>;
  markExited: (exitCode?: number) => void;
}

export function retainedChildProcess(pid: number): RetainedChildProcess {
  const state: { exitCode: number | null; signalCode: NodeJS.Signals | null } = {
    exitCode: null,
    signalCode: null,
  };
  const signalCalls: NodeJS.Signals[] = [];
  return {
    pid,
    get exitCode() {
      return state.exitCode;
    },
    get signalCode() {
      return state.signalCode;
    },
    signalCalls,
    kill: vi.fn((signal: NodeJS.Signals) => {
      signalCalls.push(signal);
      return true;
    }),
    markExited: (exitCode = 0) => {
      state.exitCode = exitCode;
    },
  };
}

export function chromeLaunchResult(
  identity: ChromeProcessIdentity,
  kill: ChromeLaunchResult["kill"],
): ChromeLaunchResult {
  return {
    pid: identity.pid,
    port: 9222,
    process: undefined,
    remoteDebuggingPipes: null,
    kill,
    processIdentity: identity,
  };
}
