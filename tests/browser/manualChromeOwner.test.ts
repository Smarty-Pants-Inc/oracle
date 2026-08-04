import { describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import {
  acquireManualChromeOwner,
  type BrowserChrome,
} from "../../src/browser/manualChromeOwner.js";
import {
  acquireProfileRunLock,
  captureProfileDirectoryIdentity,
  readDevToolsPort,
  readOracleChromeOwner,
  writeOracleChromeOwner,
  type ChromeProcessIdentity,
} from "../../src/browser/profileState.js";
import {
  acquireBrowserTabLease,
  type BrowserTabLease,
} from "../../src/browser/tabLeaseRegistry.js";

const logger = vi.fn<(message: string) => void>();

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = () => resolvePromise();
  });
  return { promise, resolve };
}
async function writeNativeDevToolsActivePort(profileDir: string, port: number): Promise<void> {
  await fs.writeFile(
    path.join(profileDir, "DevToolsActivePort"),
    `${port}\n/devtools/browser`,
    "utf8",
  );
}

async function chromeIdentity(
  profileDir: string,
  pid: number,
  launchNonce: string,
): Promise<ChromeProcessIdentity> {
  const executablePath =
    process.platform === "win32"
      ? "c:\\program files\\google\\chrome\\application\\chrome.exe"
      : process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "/usr/bin/google-chrome";
  const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
  return {
    pid,
    processStartTime: "2026-08-04T12:00:00.000Z",
    executablePath,
    normalizedUserDataDir:
      process.platform === "win32"
        ? profileDirectory.canonicalPath.toLowerCase()
        : profileDirectory.canonicalPath,
    launchNonce,
    profileDirectory,
  };
}

function launchedChrome(
  pid: number,
  port: number,
  processIdentity: ChromeProcessIdentity,
): BrowserChrome {
  return {
    pid,
    port,
    processIdentity,
    kill: vi.fn(async () => ({ status: "stopped", pid, signal: "SIGTERM" }) as const),
    process: undefined,
  } as unknown as BrowserChrome;
}

describe("manual Chrome owner acquisition", () => {
  test("serializes concurrent normal and fallback acquisition without conflating tab leases", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-manual-owner-"));
    const sentinelPath = path.join(profileDir, "Default", "Login Data");
    let normalLease: BrowserTabLease | null = null;
    let fallbackLease: BrowserTabLease | null = null;
    try {
      await fs.mkdir(path.dirname(sentinelPath), { recursive: true });
      await fs.writeFile(sentinelPath, "signed-in-profile", "utf8");
      const config = resolveBrowserConfig({
        manualLogin: true,
        manualLoginProfileDir: profileDir,
        profileLockTimeoutMs: 2_000,
        reuseChromeWaitMs: 0,
        maxConcurrentTabs: 2,
      });
      normalLease = await acquireBrowserTabLease(profileDir, {
        maxConcurrentTabs: 2,
        timeoutMs: 1_000,
        sessionId: "normal-run",
      });
      fallbackLease = await acquireBrowserTabLease(profileDir, {
        maxConcurrentTabs: 2,
        timeoutMs: 1_000,
        sessionId: "fallback-recovery",
      });

      const canonicalPid = 43_210;
      const canonicalPort = 45_678;
      const canonicalIdentity = await chromeIdentity(
        profileDir,
        canonicalPid,
        "00000000-0000-4000-8000-000000000001",
      );
      let ownerLaunched = false;
      const launchStarted = createDeferred();
      const allowLaunchToFinish = createDeferred();
      const launch = vi.fn(async () => {
        ownerLaunched = true;
        launchStarted.resolve();
        await allowLaunchToFinish.promise;
        return launchedChrome(canonicalPid, canonicalPort, canonicalIdentity);
      });
      const discoverExactProfileChrome = vi.fn(async () =>
        ownerLaunched ? { pid: canonicalPid, port: canonicalPort } : null,
      );
      const writeOwner = vi.fn(writeOracleChromeOwner);
      const verifyIdentity = vi.fn(
        async (_profileDir: string, identity: ChromeProcessIdentity) =>
          identity.launchNonce === canonicalIdentity.launchNonce,
      );
      const secondLockAttempted = createDeferred();
      let lockAttempts = 0;
      const acquireProfileLock = vi.fn(
        async (...args: Parameters<typeof acquireProfileRunLock>) => {
          lockAttempts += 1;
          if (lockAttempts === 2) secondLockAttempted.resolve();
          return acquireProfileRunLock(...args);
        },
      );
      const deps = {
        acquireProfileLock,
        launch,
        discoverExactProfileChrome,
        probe: vi.fn(async () => ({ ok: true as const })),
        verifyIdentity,
        writeOwner,
      };

      const normalOwnerPromise = acquireManualChromeOwner(
        profileDir,
        config,
        logger,
        "normal-run",
        deps,
      );
      await launchStarted.promise;
      const fallbackOwnerPromise = acquireManualChromeOwner(
        profileDir,
        config,
        logger,
        "fallback-recovery",
        deps,
      );
      await secondLockAttempted.promise;
      allowLaunchToFinish.resolve();
      const [normalOwner, fallbackOwner] = await Promise.all([
        normalOwnerPromise,
        fallbackOwnerPromise,
      ]);
      await Promise.all([
        normalLease.update({ chromeHost: "127.0.0.1", chromePort: normalOwner.chrome.port }),
        fallbackLease.update({ chromeHost: "127.0.0.1", chromePort: fallbackOwner.chrome.port }),
      ]);

      expect(launch).toHaveBeenCalledTimes(1);
      expect([normalOwner.source, fallbackOwner.source].sort()).toEqual(["launched", "recorded"]);
      expect(normalOwner.chrome.pid).toBe(canonicalPid);
      expect(fallbackOwner.chrome.pid).toBe(canonicalPid);
      expect(await readOracleChromeOwner(profileDir)).toEqual({
        port: canonicalPort,
        processIdentity: canonicalIdentity,
      });
      const persistedOwner = JSON.parse(
        await fs.readFile(path.join(profileDir, "oracle-chrome-owner.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(persistedOwner).toEqual({
        port: canonicalPort,
        processIdentity: canonicalIdentity,
      });
      expect(Object.keys(persistedOwner).sort()).toEqual(["port", "processIdentity"]);
      await expect(fs.access(path.join(profileDir, "chrome.pid"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        fs.access(path.join(profileDir, "chrome-process-identity.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readDevToolsPort(profileDir)).toBeNull();
      expect(writeOwner).toHaveBeenCalledTimes(1);
      expect(writeOwner).toHaveBeenCalledWith(profileDir, {
        port: canonicalPort,
        processIdentity: canonicalIdentity,
      });
      expect(normalOwner.processIdentity).toEqual(canonicalIdentity);
      expect(fallbackOwner.processIdentity).toEqual(canonicalIdentity);
      expect(normalOwner.chrome.processIdentity).toEqual(canonicalIdentity);
      expect(fallbackOwner.chrome.processIdentity).toEqual(canonicalIdentity);
      expect(acquireProfileLock).toHaveBeenNthCalledWith(
        1,
        profileDir,
        expect.objectContaining({ sessionId: "normal-run" }),
      );
      expect(acquireProfileLock).toHaveBeenNthCalledWith(
        2,
        profileDir,
        expect.objectContaining({ sessionId: "fallback-recovery" }),
      );
      expect(normalLease.id).not.toBe(fallbackLease.id);

      const registry = JSON.parse(
        await fs.readFile(path.join(profileDir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: Array<{ id: string; sessionId?: string; chromePort?: number }> };
      expect(registry.leases).toHaveLength(2);
      expect(registry.leases.map((lease) => lease.sessionId).sort()).toEqual([
        "fallback-recovery",
        "normal-run",
      ]);
      expect(registry.leases.every((lease) => lease.chromePort === canonicalPort)).toBe(true);
      expect(await fs.readFile(sentinelPath, "utf8")).toBe("signed-in-profile");
    } finally {
      await normalLease?.release().catch(() => undefined);
      await fallbackLease?.release().catch(() => undefined);
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("reuses the verified atomic owner without mixing in native discovery state", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-active-owner-"));
    try {
      const identity = await chromeIdentity(
        profileDir,
        43_211,
        "00000000-0000-4000-8000-000000000002",
      );
      await writeOracleChromeOwner(profileDir, { port: 45_679, processIdentity: identity });
      await writeNativeDevToolsActivePort(profileDir, 55_679);
      const writeOwner = vi.fn(writeOracleChromeOwner);
      const launch = vi.fn();
      const discoverExactProfileChrome = vi.fn(async () => ({ pid: 43_211, port: 55_679 }));
      const verifyIdentity = vi.fn(async () => true);

      const owner = await acquireManualChromeOwner(
        profileDir,
        resolveBrowserConfig({ manualLogin: true, reuseChromeWaitMs: 0 }),
        logger,
        "active-owner-record",
        {
          discoverExactProfileChrome,
          launch,
          probe: vi.fn(async () => ({ ok: true as const })),
          verifyIdentity,
          writeOwner,
        },
      );

      expect(owner.source).toBe("recorded");
      expect(owner.chrome.port).toBe(45_679);
      expect(owner.chrome.pid).toBe(43_211);
      expect(owner.processIdentity).toEqual(identity);
      expect(writeOwner).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect(discoverExactProfileChrome).not.toHaveBeenCalled();
      expect(verifyIdentity).toHaveBeenCalledWith(profileDir, identity);
      expect(await readDevToolsPort(profileDir)).toBe(55_679);
      expect(await readOracleChromeOwner(profileDir)).toEqual({
        port: 45_679,
        processIdentity: identity,
      });
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("replaces a stale owner only as one complete rediscovered generation", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-generation-"));
    try {
      const staleIdentity = await chromeIdentity(
        profileDir,
        43_212,
        "00000000-0000-4000-8000-000000000003",
      );
      const currentIdentity = await chromeIdentity(
        profileDir,
        43_214,
        "00000000-0000-4000-8000-000000000005",
      );
      await writeOracleChromeOwner(profileDir, {
        port: 45_680,
        processIdentity: staleIdentity,
      });
      const writeOwner = vi.fn(writeOracleChromeOwner);
      const captureIdentity = vi.fn(async () => currentIdentity);
      const launch = vi.fn();

      const owner = await acquireManualChromeOwner(
        profileDir,
        resolveBrowserConfig({ manualLogin: true, reuseChromeWaitMs: 0 }),
        logger,
        "rediscovered-generation",
        {
          captureIdentity,
          discoverExactProfileChrome: vi.fn(async () => ({ pid: 43_214, port: 45_682 })),
          launch,
          probe: vi.fn(async () => ({ ok: true as const })),
          verifyIdentity: vi.fn(
            async (_profileDir: string, identity: ChromeProcessIdentity) =>
              identity.launchNonce === currentIdentity.launchNonce,
          ),
          writeOwner,
        },
      );

      expect(owner.source).toBe("rediscovered");
      expect(owner.processIdentity).toEqual(currentIdentity);
      expect(captureIdentity).toHaveBeenCalledWith(profileDir, 43_214);
      expect(writeOwner).toHaveBeenCalledOnce();
      expect(await readOracleChromeOwner(profileDir)).toEqual({
        port: 45_682,
        processIdentity: currentIdentity,
      });
      expect(launch).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("rolls back a launch when the atomic owner cannot be published", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-write-failure-"));
    try {
      const identity = await chromeIdentity(
        profileDir,
        43_215,
        "00000000-0000-4000-8000-000000000006",
      );
      const chrome = launchedChrome(43_215, 45_683, identity);
      const launch = vi.fn(async () => chrome);

      await expect(
        acquireManualChromeOwner(
          profileDir,
          resolveBrowserConfig({ manualLogin: true, reuseChromeWaitMs: 0 }),
          logger,
          "owner-write-failure",
          {
            discoverExactProfileChrome: vi.fn(async () => null),
            launch,
            readOwner: vi.fn(async () => null),
            writeOwner: vi.fn(async () => {
              throw new Error("atomic owner write failed");
            }),
          },
        ),
      ).rejects.toThrow(/atomic owner write failed/i);
      expect(launch).toHaveBeenCalledOnce();
      expect(chrome.kill).toHaveBeenCalledOnce();
      expect(await readOracleChromeOwner(profileDir)).toBeNull();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("blocks instead of launching when a reachable endpoint lacks exact profile ownership", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-unverified-owner-"));
    try {
      await writeNativeDevToolsActivePort(profileDir, 45_681);
      const launch = vi.fn();
      const writeOwner = vi.fn(writeOracleChromeOwner);

      await expect(
        acquireManualChromeOwner(
          profileDir,
          resolveBrowserConfig({ manualLogin: true, reuseChromeWaitMs: 0 }),
          logger,
          "unverified",
          {
            discoverExactProfileChrome: vi.fn(async () => null),
            launch,
            probe: vi.fn(async () => ({ ok: true as const })),
            writeOwner,
          },
        ),
      ).rejects.toThrow(/exact Chrome process\/profile owner could not be verified/i);
      expect(launch).not.toHaveBeenCalled();
      expect(writeOwner).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("refuses split-brain launch after the locked profile path is retargeted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-retarget-"));
    const profileDir = path.join(root, "profile");
    const movedProfileDir = path.join(root, "moved-profile");
    await fs.mkdir(profileDir);
    try {
      const lockedProfile = await captureProfileDirectoryIdentity(profileDir);
      const release = vi.fn(async () => undefined);
      const launch = vi.fn();

      await expect(
        acquireManualChromeOwner(
          profileDir,
          resolveBrowserConfig({ manualLogin: true, reuseChromeWaitMs: 0 }),
          logger,
          "retargeted-profile",
          {
            acquireProfileLock: vi.fn(async () => ({
              path: path.join(lockedProfile.canonicalPath, "oracle-automation.lock"),
              lockId: "locked-profile-generation",
              profileDirectory: lockedProfile,
              release,
            })),
            discoverExactProfileChrome: vi.fn(async () => {
              await fs.rename(profileDir, movedProfileDir);
              await fs.mkdir(profileDir);
              return null;
            }),
            launch,
          },
        ),
      ).rejects.toThrow(/physical profile authority changed/i);
      expect(launch).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rolls back a current launch when profile lock release loses authority", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-release-"));
    try {
      const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
      const identity = await chromeIdentity(
        profileDir,
        43_213,
        "00000000-0000-4000-8000-000000000004",
      );
      const stableKill = vi.fn(async () => ({
        status: "stopped" as const,
        pid: identity.pid,
        signal: "SIGTERM" as const,
      }));
      const chrome = {
        pid: identity.pid,
        port: 45_681,
        processIdentity: identity,
        kill: stableKill,
        process: undefined,
      } as unknown as BrowserChrome;
      const releaseError = new Error("profile lock authority changed");

      await expect(
        acquireManualChromeOwner(
          profileDir,
          resolveBrowserConfig({ manualLogin: true, reuseChromeWaitMs: 0 }),
          logger,
          "release-authority",
          {
            acquireProfileLock: vi.fn(async () => ({
              path: path.join(profileDirectory.canonicalPath, "oracle-automation.lock"),
              lockId: "release-authority-generation",
              profileDirectory,
              release: vi.fn(async () => {
                throw releaseError;
              }),
            })),
            discoverExactProfileChrome: vi.fn(async () => null),
            launch: vi.fn(async () => chrome),
            verifyIdentity: vi.fn(async () => true),
          },
        ),
      ).rejects.toBe(releaseError);
      expect(stableKill).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });
});
