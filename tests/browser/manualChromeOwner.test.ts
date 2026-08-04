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
  readChromePid,
  readChromeProcessIdentity,
  readDevToolsPort,
  writeChromePid,
  writeChromeProcessIdentity,
  writeDevToolsActivePort,
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

function chromeIdentity(
  profileDir: string,
  pid: number,
  launchNonce: string,
): ChromeProcessIdentity {
  const executablePath =
    process.platform === "win32"
      ? "c:\\program files\\google\\chrome\\application\\chrome.exe"
      : process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "/usr/bin/google-chrome";
  const resolvedProfileDir = path.resolve(profileDir);
  return {
    pid,
    processStartTime: "2026-08-04T12:00:00.000Z",
    executablePath,
    normalizedUserDataDir:
      process.platform === "win32" ? resolvedProfileDir.toLowerCase() : resolvedProfileDir,
    launchNonce,
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
    kill: vi.fn(async () => undefined),
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
      const canonicalIdentity = chromeIdentity(
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
      const writePid = vi.fn(writeChromePid);
      const writeIdentity = vi.fn(writeChromeProcessIdentity);
      const verifyIdentity = vi.fn(
        async (_profileDir: string, identity: ChromeProcessIdentity) =>
          identity.launchNonce === canonicalIdentity.launchNonce,
      );
      const lockReleased = createDeferred();
      let lockHeld = false;
      let lockOrdinal = 0;
      const acquireProfileLock = vi.fn(async () => {
        if (lockHeld) await lockReleased.promise;
        lockHeld = true;
        lockOrdinal += 1;
        return {
          path: path.join(profileDir, "oracle-automation.lock"),
          lockId: `lock-${lockOrdinal}`,
          release: async () => {
            lockHeld = false;
            lockReleased.resolve();
          },
        };
      });
      const deps = {
        acquireProfileLock,
        launch,
        discoverExactProfileChrome,
        probe: vi.fn(async () => ({ ok: true as const })),
        verifyIdentity,
        writeIdentity,
        writePid,
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
      expect([normalOwner.source, fallbackOwner.source].sort()).toEqual([
        "active-port",
        "launched",
      ]);
      expect(normalOwner.chrome.pid).toBe(canonicalPid);
      expect(fallbackOwner.chrome.pid).toBe(canonicalPid);
      expect(await readChromePid(profileDir)).toBe(canonicalPid);
      expect(await readDevToolsPort(profileDir)).toBe(canonicalPort);
      expect(writePid).toHaveBeenCalledTimes(1);
      expect(writeIdentity).toHaveBeenCalledTimes(1);
      expect(writeIdentity).toHaveBeenCalledWith(profileDir, canonicalIdentity);
      expect(normalOwner.processIdentity).toEqual(canonicalIdentity);
      expect(fallbackOwner.processIdentity).toEqual(canonicalIdentity);
      expect(normalOwner.chrome.processIdentity).toEqual(canonicalIdentity);
      expect(fallbackOwner.chrome.processIdentity).toEqual(canonicalIdentity);
      expect(await readChromeProcessIdentity(profileDir)).toEqual(canonicalIdentity);
      expect(writePid).toHaveBeenCalledWith(profileDir, canonicalPid);
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

  test("reuses verified active-port authority without rewriting chrome.pid", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-active-owner-"));
    try {
      await writeDevToolsActivePort(profileDir, 45_679);
      await writeChromePid(profileDir, 43_211);
      const writePid = vi.fn(writeChromePid);
      const identity = chromeIdentity(profileDir, 43_211, "00000000-0000-4000-8000-000000000002");
      await writeChromeProcessIdentity(profileDir, identity);
      const launch = vi.fn();
      const discoverExactProfileChrome = vi.fn(async () => ({ pid: 43_211, port: 45_679 }));
      const verifyIdentity = vi.fn(async () => true);
      const writeIdentity = vi.fn(writeChromeProcessIdentity);

      const owner = await acquireManualChromeOwner(
        profileDir,
        resolveBrowserConfig({ manualLogin: true, reuseChromeWaitMs: 0 }),
        logger,
        "active-port",
        {
          discoverExactProfileChrome,
          launch,
          probe: vi.fn(async () => ({ ok: true as const })),
          verifyIdentity,
          writeIdentity,
          writePid,
        },
      );

      expect(owner.source).toBe("active-port");
      expect(writePid).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect(await readChromePid(profileDir)).toBe(43_211);
      expect(owner.processIdentity).toEqual(identity);
      expect(discoverExactProfileChrome).not.toHaveBeenCalled();
      expect(verifyIdentity).toHaveBeenCalledWith(profileDir, identity);
      expect(writeIdentity).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("repairs provisional identity-only authority without changing its generation", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-provisional-owner-"));
    try {
      const identity = chromeIdentity(profileDir, 43_212, "00000000-0000-4000-8000-000000000003");
      await writeChromeProcessIdentity(profileDir, identity);
      const captureIdentity = vi.fn();
      const writeIdentity = vi.fn(writeChromeProcessIdentity);
      const writePid = vi.fn(writeChromePid);
      const launch = vi.fn();

      const owner = await acquireManualChromeOwner(
        profileDir,
        resolveBrowserConfig({ manualLogin: true, reuseChromeWaitMs: 0 }),
        logger,
        "provisional-repair",
        {
          captureIdentity,
          discoverExactProfileChrome: vi.fn(async () => ({ pid: 43_212, port: 45_680 })),
          launch,
          probe: vi.fn(async () => ({ ok: true as const })),
          verifyIdentity: vi.fn(async () => true),
          writeIdentity,
          writePid,
        },
      );

      expect(owner.source).toBe("rediscovered");
      expect(owner.processIdentity).toEqual(identity);
      expect(captureIdentity).not.toHaveBeenCalled();
      expect(writeIdentity).not.toHaveBeenCalled();
      expect(writePid).toHaveBeenCalledWith(profileDir, 43_212);
      expect(await readDevToolsPort(profileDir)).toBe(45_680);
      expect(await readChromeProcessIdentity(profileDir)).toEqual(identity);
      expect(launch).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("writes PID authority only after exact process/profile rediscovery", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-rediscovered-owner-"));
    try {
      const writePid = vi.fn(writeChromePid);
      const identity = chromeIdentity(profileDir, 43_212, "00000000-0000-4000-8000-000000000003");
      const captureIdentity = vi.fn(async () => identity);
      const writeIdentity = vi.fn(writeChromeProcessIdentity);
      const launch = vi.fn();
      const owner = await acquireManualChromeOwner(
        profileDir,
        resolveBrowserConfig({ manualLogin: true, reuseChromeWaitMs: 0 }),
        logger,
        "rediscovery",
        {
          captureIdentity,
          discoverExactProfileChrome: vi.fn(async () => ({ pid: 43_212, port: 45_680 })),
          launch,
          probe: vi.fn(async () => ({ ok: true as const })),
          verifyIdentity: vi.fn(async () => true),
          writeIdentity,
          writePid,
        },
      );

      expect(owner.source).toBe("rediscovered");
      expect(writePid).toHaveBeenCalledTimes(1);
      expect(writePid).toHaveBeenCalledWith(profileDir, 43_212);
      expect(launch).not.toHaveBeenCalled();
      expect(await readChromePid(profileDir)).toBe(43_212);
      expect(await readDevToolsPort(profileDir)).toBe(45_680);
      expect(captureIdentity).toHaveBeenCalledWith(profileDir, 43_212);
      expect(writeIdentity).toHaveBeenCalledOnce();
      expect(owner.processIdentity).toEqual(identity);
      expect(await readChromeProcessIdentity(profileDir)).toEqual(identity);
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("blocks instead of launching when a reachable endpoint lacks exact profile ownership", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-unverified-owner-"));
    try {
      await writeDevToolsActivePort(profileDir, 45_681);
      const launch = vi.fn();
      const writePid = vi.fn(writeChromePid);

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
            writePid,
          },
        ),
      ).rejects.toThrow(/exact Chrome process\/profile owner could not be verified/i);
      expect(launch).not.toHaveBeenCalled();
      expect(writePid).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });
});
