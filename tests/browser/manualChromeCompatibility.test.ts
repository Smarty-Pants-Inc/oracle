import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { acquireManualLoginChromeForRun, type BrowserChrome } from "../../src/browser/index.js";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import {
  captureProfileDirectoryIdentity,
  type ChromeProcessIdentity,
  type OracleChromeOwnerRecord,
  type ProfileRunLock,
} from "../../src/browser/profileState.js";
import type { RetainedChromeEndpointAuthority } from "../../src/browser/chromeLifecycle.js";

const logger = vi.fn<(message: string) => void>();

describe("manual-login Chrome compatibility API", () => {
  test("returns the historical reusedChrome discriminator through canonical owner authority", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-manual-compat-"));
    try {
      const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
      const processIdentity: ChromeProcessIdentity = {
        pid: 43_210,
        processStartTime: "2026-08-05T00:00:00.000Z",
        executablePath:
          process.platform === "win32"
            ? "c:\\program files\\google\\chrome\\application\\chrome.exe"
            : process.platform === "darwin"
              ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
              : "/usr/bin/google-chrome",
        normalizedUserDataDir:
          process.platform === "win32"
            ? profileDirectory.canonicalPath.toLowerCase()
            : profileDirectory.canonicalPath,
        launchNonce: "00000000-0000-4000-8000-000000000042",
        profileDirectory,
      };
      const settlementOrder: string[] = [];
      const endpointAuthority: RetainedChromeEndpointAuthority = {
        browserWSEndpoint: "ws://127.0.0.1:9333/devtools/browser/manual-compat",
        kill: vi.fn(async () => ({ status: "already-stopped" as const, pid: 43_210 })),
        release: vi.fn(async () => {
          settlementOrder.push("endpoint-release");
        }),
      };
      const legacyKill = vi.fn(async () => undefined);
      const reusable = {
        pid: 43_210,
        port: 9333,
        host: "127.0.0.1",
        processIdentity,
        endpointAuthority,
        kill: legacyKill,
        process: undefined,
      } as unknown as BrowserChrome;
      let ownerRecord: OracleChromeOwnerRecord | null = null;
      const maybeReuse = vi.fn(async () => reusable);
      const launch = vi.fn();
      const releaseLock = vi.fn(async () => {
        settlementOrder.push("lock-release");
      });

      const result = await acquireManualLoginChromeForRun(
        profileDir,
        resolveBrowserConfig({
          manualLogin: true,
          manualLoginProfileDir: profileDir,
          profileLockTimeoutMs: 1_000,
          reuseChromeWaitMs: 125,
          keepBrowser: false,
        }),
        logger,
        "compat-run",
        {
          acquireProfileLock: vi.fn(
            async (): Promise<ProfileRunLock> => ({
              path: path.join(profileDir, "oracle-automation.lock"),
              lockId: "compat-lock",
              profileDirectory,
              release: releaseLock,
            }),
          ),
          maybeReuse,
          launch,
          readOwner: vi.fn(async () => ownerRecord),
          writeOwner: vi.fn(async (_dir, owner) => {
            ownerRecord = owner;
          }),
          verifyIdentity: vi.fn(async () => true),
        },
      );

      expect(result.chrome).toBe(result.reusedChrome);
      expect(result.chrome).toBe(reusable);
      expect(Object.keys(result).sort()).toEqual(["chrome", "reusedChrome"]);
      expect(result.chrome).toMatchObject({ pid: 43_210, port: 9333, host: "127.0.0.1" });
      expect(result.chrome.kill).toBe(legacyKill);
      expect(legacyKill).not.toHaveBeenCalled();
      expect(maybeReuse).toHaveBeenCalledWith(profileDir, logger, { waitForPortMs: 125 });
      expect(launch).not.toHaveBeenCalled();
      expect(ownerRecord).toMatchObject({
        port: 9333,
        processIdentity,
        disposition: "close-on-last-lease",
      });
      expect(settlementOrder).toEqual(["lock-release", "endpoint-release"]);
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("returns the exact Chrome supplied by the historical launch dependency", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-manual-launch-compat-"));
    try {
      const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
      const processIdentity: ChromeProcessIdentity = {
        pid: 43_211,
        processStartTime: "2026-08-05T00:00:01.000Z",
        executablePath:
          process.platform === "win32"
            ? "c:\\program files\\google\\chrome\\application\\chrome.exe"
            : process.platform === "darwin"
              ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
              : "/usr/bin/google-chrome",
        normalizedUserDataDir:
          process.platform === "win32"
            ? profileDirectory.canonicalPath.toLowerCase()
            : profileDirectory.canonicalPath,
        launchNonce: "00000000-0000-4000-8000-000000000043",
        profileDirectory,
      };
      const settlementOrder: string[] = [];
      const endpointAuthority: RetainedChromeEndpointAuthority = {
        browserWSEndpoint: "ws://127.0.0.1:9444/devtools/browser/manual-launch-compat",
        kill: vi.fn(async () => ({ status: "already-stopped" as const, pid: 43_211 })),
        release: vi.fn(async () => {
          settlementOrder.push("endpoint-release");
        }),
      };
      const legacyKill = vi.fn(async () => undefined);
      const launched = {
        pid: 43_211,
        port: 9444,
        host: "127.0.0.1",
        kill: legacyKill,
        process: undefined,
      } as unknown as BrowserChrome;
      let ownerRecord: OracleChromeOwnerRecord | null = null;
      const maybeReuse = vi.fn(async () => null);
      const launch = vi.fn(async () => launched);
      const releaseLock = vi.fn(async () => {
        settlementOrder.push("lock-release");
      });
      const config = resolveBrowserConfig({
        manualLogin: true,
        manualLoginProfileDir: profileDir,
        profileLockTimeoutMs: 1_000,
        reuseChromeWaitMs: 125,
        keepBrowser: false,
      });

      const result = await acquireManualLoginChromeForRun(
        profileDir,
        config,
        logger,
        "compat-launch-run",
        {
          acquireProfileLock: vi.fn(
            async (): Promise<ProfileRunLock> => ({
              path: path.join(profileDir, "oracle-automation.lock"),
              lockId: "compat-launch-lock",
              profileDirectory,
              release: releaseLock,
            }),
          ),
          maybeReuse,
          launch,
          captureProcessIdentity: vi.fn(async () => processIdentity),
          retainEndpointAuthority: vi.fn(async () => endpointAuthority),
          readOwner: vi.fn(async () => ownerRecord),
          writeOwner: vi.fn(async (_dir, owner) => {
            ownerRecord = owner;
          }),
          verifyIdentity: vi.fn(async () => true),
        },
      );

      expect(result.chrome).toBe(launched);
      expect(Object.keys(result).sort()).toEqual(["chrome", "reusedChrome"]);
      expect(result.reusedChrome).toBeNull();
      expect(result.chrome.kill).toBe(legacyKill);
      expect(legacyKill).not.toHaveBeenCalled();
      expect(maybeReuse).toHaveBeenCalledWith(profileDir, logger, { waitForPortMs: 125 });
      expect(launch).toHaveBeenCalledWith(config, profileDir, logger);
      expect(ownerRecord).toMatchObject({
        port: 9444,
        processIdentity,
        disposition: "close-on-last-lease",
      });
      expect(settlementOrder).toEqual(["lock-release", "endpoint-release"]);
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });
});
