import { describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import {
  acquireManualChromeOwner as acquireManualChromeOwnerWithAuthority,
  releaseManualChromeOwnerEndpointAuthority,
  settleManualChromeOwner,
  type ManualChromeOwner,
} from "../../src/browser/manualChromeOwner.js";
import type { ChromeProcessIdentity } from "../../src/browser/chromeProcessIdentity.js";
import {
  acquireProfileRunLock,
  captureProfileDirectoryIdentity,
  readDevToolsPort,
  readOracleChromeOwner,
  writeOracleChromeOwner,
} from "../../src/browser/profileState.js";
import {
  acquireBrowserTabLease as acquireBrowserTabLeaseWithAuthority,
  retainBrowserTabLeaseTeardownAuthority,
  type BrowserTabLease,
} from "../../src/browser/tabLeaseRegistry.js";
import type {
  ChromeLaunchResult,
  RetainedChromeEndpointAuthority,
} from "../../src/browser/chromeLifecycle.js";
import { testProcessIdentityProvider } from "./filesystemLockTestHelpers.js";

const TEST_LEASE_LIVENESS_DEPS = {
  readProcessLiveness: testProcessIdentityProvider.readProcessLiveness,
  readProcessStartIdentity: testProcessIdentityProvider.readProcessStartIdentity,
};

async function acquireBrowserTabLease(
  profileDir: Parameters<typeof acquireBrowserTabLeaseWithAuthority>[0],
  options: Parameters<typeof acquireBrowserTabLeaseWithAuthority>[1],
  deps: Parameters<typeof acquireBrowserTabLeaseWithAuthority>[2] = {},
) {
  return acquireBrowserTabLeaseWithAuthority(profileDir, options, {
    ...TEST_LEASE_LIVENESS_DEPS,
    ...deps,
  });
}
async function acquireManualChromeOwner(
  profileDir: Parameters<typeof acquireManualChromeOwnerWithAuthority>[0],
  config: Parameters<typeof acquireManualChromeOwnerWithAuthority>[1],
  logger: Parameters<typeof acquireManualChromeOwnerWithAuthority>[2],
  sessionId: Parameters<typeof acquireManualChromeOwnerWithAuthority>[3],
  deps: Parameters<typeof acquireManualChromeOwnerWithAuthority>[4] = {},
) {
  return acquireManualChromeOwnerWithAuthority(profileDir, config, logger, sessionId, {
    acquireProfileLock: (userDataDir, options) =>
      acquireProfileRunLock(userDataDir, options, {
        processIdentityProvider: testProcessIdentityProvider,
      }),
    ...deps,
  });
}

const logger = vi.fn<(message: string) => void>();

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
  endpointAuthority?: RetainedChromeEndpointAuthority,
): ChromeLaunchResult {
  return {
    pid,
    port,
    processIdentity,
    endpointAuthority,
    kill: vi.fn(async () => ({ status: "stopped", pid, signal: "SIGTERM" }) as const),
    process: undefined,
  } as unknown as ChromeLaunchResult;
}

function retainedEndpointAuthority(
  identity: ChromeProcessIdentity,
  port: number,
): RetainedChromeEndpointAuthority {
  return {
    browserWSEndpoint: `ws://127.0.0.1:${port}/devtools/browser/exact-${identity.pid}`,
    kill: vi.fn(async () => ({ status: "already-stopped" as const, pid: identity.pid })),
    release: vi.fn(async () => undefined),
  };
}

describe("manual Chrome owner acquisition", () => {
  // Exercises real crash-recoverable lease helpers whose Windows subprocess path exceeds Vitest's default budget under suite contention.
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
        generationId: "normal-generation",
      });
      fallbackLease = await acquireBrowserTabLease(profileDir, {
        maxConcurrentTabs: 2,
        timeoutMs: 1_000,
        sessionId: "fallback-recovery",
        generationId: "fallback-generation",
      });

      const canonicalPid = 43_210;
      const canonicalPort = 45_678;
      const canonicalIdentity = await chromeIdentity(
        profileDir,
        canonicalPid,
        "00000000-0000-4000-8000-000000000001",
      );
      let ownerLaunched = false;
      const launchStarted = Promise.withResolvers<void>();
      const allowLaunchToFinish = Promise.withResolvers<void>();
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
      const endpointAuthority = retainedEndpointAuthority(canonicalIdentity, canonicalPort);
      const retainEndpointAuthority = vi.fn(async () => endpointAuthority);
      const fallbackLockQueued = Promise.withResolvers<void>();
      const normalLockReleased = Promise.withResolvers<void>();
      const lockHandoff: string[] = [];
      let lockAttempts = 0;
      // Filesystem-lock mechanics have dedicated coverage; keep this fixture focused on the
      // owner-lock handoff while the real tab-lease registry preserves distinct lease generations.
      const acquireProfileLock = vi.fn(
        async (..._args: Parameters<typeof acquireProfileRunLock>) => {
          lockAttempts += 1;
          const lockGeneration = lockAttempts;
          if (lockGeneration === 1) {
            lockHandoff.push("normal-acquired");
          } else {
            lockHandoff.push("fallback-waiting");
            fallbackLockQueued.resolve();
            await normalLockReleased.promise;
            lockHandoff.push("fallback-acquired");
          }
          return {
            path: path.join(
              canonicalIdentity.profileDirectory.canonicalPath,
              "oracle-automation.lock",
            ),
            lockId: `test-owner-lock-${lockGeneration}`,
            profileDirectory: canonicalIdentity.profileDirectory,
            release: vi.fn(async () => {
              if (lockGeneration === 1) {
                lockHandoff.push("normal-released");
                normalLockReleased.resolve();
              } else {
                lockHandoff.push("fallback-released");
              }
            }),
          };
        },
      );
      const deps = {
        acquireProfileLock,
        launch,
        discoverExactProfileChrome,
        probe: vi.fn(async () => ({ ok: true as const })),
        verifyIdentity,
        retainEndpointAuthority,
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
      await fallbackLockQueued.promise;
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
        disposition: "close-on-last-lease",
      });
      const persistedOwner = JSON.parse(
        await fs.readFile(path.join(profileDir, "oracle-chrome-owner.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(persistedOwner).toEqual({
        port: canonicalPort,
        processIdentity: canonicalIdentity,
        disposition: "close-on-last-lease",
      });
      expect(Object.keys(persistedOwner).sort()).toEqual([
        "disposition",
        "port",
        "processIdentity",
      ]);
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
        disposition: "close-on-last-lease",
      });
      expect(normalOwner.processIdentity).toEqual(canonicalIdentity);
      expect(fallbackOwner.processIdentity).toEqual(canonicalIdentity);
      expect(normalOwner.chrome.processIdentity).toEqual(canonicalIdentity);
      expect(fallbackOwner.chrome.processIdentity).toEqual(canonicalIdentity);
      expect(retainEndpointAuthority).toHaveBeenCalledOnce();
      expect(fallbackOwner.chrome.kill).toBe(endpointAuthority.kill);
      expect(fallbackOwner.chrome.endpointAuthority).toBe(endpointAuthority);
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
      expect(lockHandoff).toEqual([
        "normal-acquired",
        "fallback-waiting",
        "normal-released",
        "fallback-acquired",
        "fallback-released",
      ]);
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
  }, 15_000);

  test("reconciles the verified atomic owner without mixing in native discovery state", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-active-owner-"));
    try {
      const identity = await chromeIdentity(
        profileDir,
        43_211,
        "00000000-0000-4000-8000-000000000002",
      );
      await fs.writeFile(
        path.join(profileDir, "oracle-chrome-owner.json"),
        `${JSON.stringify({ port: 45_679, processIdentity: identity })}\n`,
        "utf8",
      );
      await writeNativeDevToolsActivePort(profileDir, 55_679);
      const writeOwner = vi.fn(writeOracleChromeOwner);
      const launch = vi.fn();
      const discoverExactProfileChrome = vi.fn(async () => ({ pid: 43_211, port: 55_679 }));
      const verifyIdentity = vi.fn(async () => true);
      const endpointAuthority = retainedEndpointAuthority(identity, 45_679);
      const retainEndpointAuthority = vi.fn(async () => endpointAuthority);

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
          retainEndpointAuthority,
          writeOwner,
        },
      );

      expect(owner.source).toBe("recorded");
      expect(owner.disposition).toBe("close-on-last-lease");
      expect(owner.chrome.port).toBe(45_679);
      expect(owner.chrome.pid).toBe(43_211);
      expect(owner.processIdentity).toEqual(identity);
      expect(writeOwner).toHaveBeenCalledOnce();
      expect(launch).not.toHaveBeenCalled();
      expect(discoverExactProfileChrome).not.toHaveBeenCalled();
      expect(verifyIdentity).toHaveBeenCalledWith(profileDir, identity);
      expect(retainEndpointAuthority).toHaveBeenCalledWith({
        host: "127.0.0.1",
        port: 45_679,
        userDataDir: profileDir,
        processIdentity: identity,
      });
      expect(owner.chrome.kill).toBe(endpointAuthority.kill);
      expect(owner.chrome.endpointAuthority).toBe(endpointAuthority);
      expect(await readDevToolsPort(profileDir)).toBe(55_679);
      expect(await readOracleChromeOwner(profileDir)).toEqual({
        port: 45_679,
        processIdentity: identity,
        disposition: "close-on-last-lease",
      });
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("refuses to adopt a pre-existing Chrome generation when its owner record is stale", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-generation-"));
    try {
      const staleIdentity = await chromeIdentity(
        profileDir,
        43_212,
        "00000000-0000-4000-8000-000000000003",
      );
      await writeOracleChromeOwner(profileDir, {
        port: 45_680,
        processIdentity: staleIdentity,
        disposition: "close-on-last-lease",
      });
      const writeOwner = vi.fn(writeOracleChromeOwner);
      const launch = vi.fn();
      const retainEndpointAuthority = vi.fn();

      await expect(
        acquireManualChromeOwner(
          profileDir,
          resolveBrowserConfig({ manualLogin: true, reuseChromeWaitMs: 0 }),
          logger,
          "pre-existing-generation",
          {
            discoverExactProfileChrome: vi.fn(async () => ({ pid: 43_214, port: 45_682 })),
            launch,
            probe: vi.fn(async () => ({ ok: true as const })),
            verifyIdentity: vi.fn(async () => false),
            retainEndpointAuthority,
            writeOwner,
          },
        ),
      ).rejects.toThrow(/refusing to adopt a pre-existing manual-login browser/i);

      expect(retainEndpointAuthority).not.toHaveBeenCalled();
      expect(writeOwner).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect(await readOracleChromeOwner(profileDir)).toEqual({
        port: 45_680,
        processIdentity: staleIdentity,
        disposition: "close-on-last-lease",
      });
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("rejects a reachable recorded endpoint owned by another process generation", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-endpoint-mismatch-"));
    try {
      const identity = await chromeIdentity(
        profileDir,
        43_215,
        "00000000-0000-4000-8000-000000000015",
      );
      await writeOracleChromeOwner(profileDir, {
        port: 45_683,
        processIdentity: identity,
        disposition: "preserve",
      });
      const launch = vi.fn();
      const retainEndpointAuthority = vi.fn(async () => {
        throw new Error("CDP browser pid 9999 belongs to another generation");
      });

      await expect(
        acquireManualChromeOwner(
          profileDir,
          resolveBrowserConfig({ manualLogin: true, reuseChromeWaitMs: 0 }),
          logger,
          "recorded-endpoint-mismatch",
          {
            launch,
            probe: vi.fn(async () => ({ ok: true as const })),
            retainEndpointAuthority,
            verifyIdentity: vi.fn(async () => true),
          },
        ),
      ).rejects.toThrow(/not bound to that exact process generation/i);
      expect(retainEndpointAuthority).toHaveBeenCalledWith({
        host: "127.0.0.1",
        port: 45_683,
        userDataDir: profileDir,
        processIdentity: identity,
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

  test.each(["termination-unsafe", "owner-removal-unconfirmed"] as const)(
    "surfaces %s during failed owner publication rollback",
    async (failureMode) => {
      const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-rollback-failure-"));
      try {
        const identity = await chromeIdentity(
          profileDir,
          43_224,
          "00000000-0000-4000-8000-000000000016",
        );
        const chrome = launchedChrome(identity.pid, 45_692, identity);
        if (failureMode === "termination-unsafe") {
          vi.mocked(chrome.kill).mockResolvedValue({
            status: "unsafe",
            pid: identity.pid,
            reason: "exact endpoint teardown unavailable",
          });
        }
        const removeOwnerIfMatches = vi.fn(async () => false);

        await expect(
          acquireManualChromeOwner(
            profileDir,
            resolveBrowserConfig({ manualLogin: true, reuseChromeWaitMs: 0 }),
            logger,
            `owner-rollback-${failureMode}`,
            {
              removeOwnerIfMatches,
              discoverExactProfileChrome: vi.fn(async () => null),
              launch: vi.fn(async () => chrome),
              readOwner: vi.fn(async () => null),
              writeOwner: vi.fn(async () => {
                throw new Error("atomic owner write failed");
              }),
            },
          ),
        ).rejects.toThrow(/rollback did not settle safely/i);
        expect(chrome.kill).toHaveBeenCalledOnce();
        expect(removeOwnerIfMatches).toHaveBeenCalledTimes(
          failureMode === "owner-removal-unconfirmed" ? 1 : 0,
        );
      } finally {
        await fs.rm(profileDir, { recursive: true, force: true });
      }
    },
  );

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

  test("preserves the original acquisition failure when lock release succeeds", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-primary-error-"));
    try {
      const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
      const acquisitionError = new Error("canonical owner discovery failed");
      const release = vi.fn(async () => undefined);

      await expect(
        acquireManualChromeOwner(
          profileDir,
          resolveBrowserConfig({ manualLogin: true, reuseChromeWaitMs: 0 }),
          logger,
          "primary-acquisition-error",
          {
            acquireProfileLock: vi.fn(async () => ({
              path: path.join(profileDirectory.canonicalPath, "oracle-automation.lock"),
              lockId: "primary-acquisition-error",
              profileDirectory,
              release,
            })),
            discoverExactProfileChrome: vi.fn(async () => {
              throw acquisitionError;
            }),
          },
        ),
      ).rejects.toBe(acquisitionError);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("keeps acquisition failure primary when lock release also fails", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-aggregate-error-"));
    try {
      const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
      const acquisitionError = new Error("canonical owner discovery failed");
      const releaseError = new Error("canonical owner lock release failed");

      await expect(
        acquireManualChromeOwner(
          profileDir,
          resolveBrowserConfig({ manualLogin: true, reuseChromeWaitMs: 0 }),
          logger,
          "aggregate-acquisition-error",
          {
            acquireProfileLock: vi.fn(async () => ({
              path: path.join(profileDirectory.canonicalPath, "oracle-automation.lock"),
              lockId: "aggregate-acquisition-error",
              profileDirectory,
              release: vi.fn(async () => {
                throw releaseError;
              }),
            })),
            discoverExactProfileChrome: vi.fn(async () => {
              throw acquisitionError;
            }),
          },
        ),
      ).rejects.toMatchObject({
        name: "AggregateError",
        cause: acquisitionError,
        errors: [acquisitionError, releaseError],
      });
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
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
      } as unknown as ChromeLaunchResult;
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

  // Exercises real crash-recoverable lease helpers whose Windows subprocess path exceeds Vitest's default budget under suite contention.
  test("reconciles a bootstrap preserve to close on the final direct-run lease", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-policy-cutover-"));
    try {
      const identity = await chromeIdentity(
        profileDir,
        43_225,
        "00000000-0000-4000-8000-000000000017",
      );
      const bootstrapAuthority = retainedEndpointAuthority(identity, 45_693);
      const normalAuthority = retainedEndpointAuthority(identity, 45_693);
      const bootstrap = await acquireManualChromeOwner(
        profileDir,
        resolveBrowserConfig({ manualLogin: true, keepBrowser: true, reuseChromeWaitMs: 0 }),
        logger,
        "bootstrap",
        {
          discoverExactProfileChrome: vi.fn(async () => null),
          launch: vi.fn(async () =>
            launchedChrome(identity.pid, 45_693, identity, bootstrapAuthority),
          ),
          verifyIdentity: vi.fn(async () => true),
        },
      );
      const normal = await acquireManualChromeOwner(
        profileDir,
        resolveBrowserConfig({ manualLogin: true, keepBrowser: false, reuseChromeWaitMs: 0 }),
        logger,
        "normal",
        {
          retainEndpointAuthority: vi.fn(async () => normalAuthority),
          verifyIdentity: vi.fn(async () => true),
        },
      );

      expect(bootstrap.disposition).toBe("preserve");
      expect(normal.disposition).toBe("close-on-last-lease");
      const reconciledOwner = await readOracleChromeOwner(profileDir);
      expect(reconciledOwner?.disposition).toBe("close-on-last-lease");
      expect(reconciledOwner?.preservationPolicy).toBeUndefined();

      const firstLease = await acquireBrowserTabLease(profileDir, {
        maxConcurrentTabs: 2,
        sessionId: "bootstrap",
        generationId: "bootstrap-generation",
      });
      const finalLease = await acquireBrowserTabLease(profileDir, {
        maxConcurrentTabs: 2,
        sessionId: "normal",
        generationId: "normal-generation",
      });
      const firstTeardown = retainBrowserTabLeaseTeardownAuthority(profileDir, firstLease, {
        ...TEST_LEASE_LIVENESS_DEPS,
        onActiveLeaseHandoff: () => releaseManualChromeOwnerEndpointAuthority(bootstrap),
      });
      await expect(firstTeardown.settle(async () => true)).resolves.toMatchObject({
        disposition: "active-lease-handoff",
      });
      expect(normalAuthority.kill).not.toHaveBeenCalled();

      const finalTeardown = retainBrowserTabLeaseTeardownAuthority(profileDir, finalLease, {
        ...TEST_LEASE_LIVENESS_DEPS,
      });
      await expect(
        finalTeardown.settle(async () => {
          const settlement = await settleManualChromeOwner(profileDir, normal, logger);
          return settlement.status === "terminated";
        }),
      ).resolves.toMatchObject({ disposition: "teardown-completed" });
      expect(normalAuthority.kill).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("does not let a direct run overwrite service-owned preservation", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-service-owner-policy-"));
    try {
      const identity = await chromeIdentity(
        profileDir,
        43_226,
        "00000000-0000-4000-8000-000000000018",
      );
      const serviceAuthority = retainedEndpointAuthority(identity, 45_694);
      const directAuthority = retainedEndpointAuthority(identity, 45_694);
      const serviceOwner = await acquireManualChromeOwner(
        profileDir,
        resolveBrowserConfig({ manualLogin: true, keepBrowser: false, reuseChromeWaitMs: 0 }),
        logger,
        "remote-serve-bootstrap",
        {
          ownerPolicy: "service-persistent",
          discoverExactProfileChrome: vi.fn(async () => null),
          launch: vi.fn(async () =>
            launchedChrome(identity.pid, 45_694, identity, serviceAuthority),
          ),
          verifyIdentity: vi.fn(async () => true),
        },
      );
      const directOwner = await acquireManualChromeOwner(
        profileDir,
        resolveBrowserConfig({ manualLogin: true, keepBrowser: false, reuseChromeWaitMs: 0 }),
        logger,
        "direct-no-keep",
        {
          retainEndpointAuthority: vi.fn(async () => directAuthority),
          verifyIdentity: vi.fn(async () => true),
        },
      );

      expect(serviceOwner.disposition).toBe("preserve");
      expect(directOwner.disposition).toBe("preserve");
      await expect(readOracleChromeOwner(profileDir)).resolves.toMatchObject({
        disposition: "preserve",
        preservationPolicy: "service-persistent",
      });
      await expect(settleManualChromeOwner(profileDir, directOwner, logger)).resolves.toEqual({
        status: "preserved",
      });
      expect(directAuthority.kill).not.toHaveBeenCalled();
      expect(directAuthority.release).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });
});

describe("manual Chrome owner settlement", () => {
  test.each([
    ["launched", "preserve", "preserved"],
    ["recorded", "close-on-last-lease", "terminated"],
    ["rediscovered", "preserve", "preserved"],
  ] as const)(
    "settles a %s owner according to its %s disposition",
    async (source, disposition, status) => {
      const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-settlement-"));
      try {
        const identity = await chromeIdentity(
          profileDir,
          43_216,
          "00000000-0000-4000-8000-000000000007",
        );
        const chrome = launchedChrome(identity.pid, 45_684, identity);
        await writeOracleChromeOwner(profileDir, {
          port: chrome.port,
          processIdentity: identity,
          disposition,
        });
        const endpointAuthority = retainedEndpointAuthority(identity, 45_684);
        const owner: ManualChromeOwner = {
          chrome,
          processIdentity: identity,
          source,
          disposition,
          endpointAuthority,
        };

        await expect(settleManualChromeOwner(profileDir, owner, logger)).resolves.toEqual({
          status,
        });
        expect(endpointAuthority.kill).toHaveBeenCalledTimes(status === "terminated" ? 1 : 0);
        expect(chrome.kill).not.toHaveBeenCalled();
        expect(endpointAuthority.release).toHaveBeenCalledTimes(status === "preserved" ? 1 : 0);
        expect((await readOracleChromeOwner(profileDir)) === null).toBe(status === "terminated");
      } finally {
        await fs.rm(profileDir, { recursive: true, force: true });
      }
    },
  );

  test("uses the canonical close disposition instead of a stale retained preserve policy", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-canonical-close-"));
    try {
      const identity = await chromeIdentity(
        profileDir,
        43_221,
        "00000000-0000-4000-8000-000000000012",
      );
      const chrome = launchedChrome(identity.pid, 45_689, identity);
      const endpointAuthority = retainedEndpointAuthority(identity, chrome.port);
      await writeOracleChromeOwner(profileDir, {
        port: chrome.port,
        processIdentity: identity,
        disposition: "close-on-last-lease",
      });

      await expect(
        settleManualChromeOwner(
          profileDir,
          {
            chrome,
            processIdentity: identity,
            source: "recorded",
            disposition: "preserve",
            endpointAuthority,
          },
          logger,
        ),
      ).resolves.toEqual({ status: "terminated" });
      expect(endpointAuthority.kill).toHaveBeenCalledOnce();
      expect(chrome.kill).not.toHaveBeenCalled();
      expect(endpointAuthority.release).not.toHaveBeenCalled();
      await expect(readOracleChromeOwner(profileDir)).resolves.toBeNull();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("retries a failed preserve release without losing exact endpoint authority", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-release-retry-"));
    try {
      const identity = await chromeIdentity(
        profileDir,
        43_222,
        "00000000-0000-4000-8000-000000000013",
      );
      const chrome = launchedChrome(identity.pid, 45_690, identity);
      const endpointAuthority = retainedEndpointAuthority(identity, chrome.port);
      vi.mocked(endpointAuthority.release)
        .mockRejectedValueOnce(new Error("transient endpoint release failure"))
        .mockResolvedValueOnce(undefined);
      await writeOracleChromeOwner(profileDir, {
        port: chrome.port,
        processIdentity: identity,
        disposition: "preserve",
      });
      const owner: ManualChromeOwner = {
        chrome,
        processIdentity: identity,
        source: "recorded",
        disposition: "preserve",
        endpointAuthority,
      };

      await expect(settleManualChromeOwner(profileDir, owner, logger)).resolves.toMatchObject({
        status: "unsafe",
        reason: expect.stringMatching(/transient endpoint release failure/i),
      });
      await expect(settleManualChromeOwner(profileDir, owner, logger)).resolves.toEqual({
        status: "preserved",
      });
      expect(endpointAuthority.release).toHaveBeenCalledTimes(2);
      expect(chrome.kill).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test.each(["legacy", "current-preserve"] as const)(
    "never closes through a stale retained policy when canonical authority is %s",
    async (canonicalState) => {
      const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-policy-"));
      try {
        const identity = await chromeIdentity(
          profileDir,
          43_219,
          "00000000-0000-4000-8000-000000000010",
        );
        const chrome = launchedChrome(identity.pid, 45_687, identity);
        const endpointAuthority = retainedEndpointAuthority(identity, chrome.port);
        if (canonicalState === "legacy") {
          await fs.writeFile(
            path.join(profileDir, "oracle-chrome-owner.json"),
            `${JSON.stringify({ port: chrome.port, processIdentity: identity })}\n`,
            "utf8",
          );
        } else if (canonicalState === "current-preserve") {
          await writeOracleChromeOwner(profileDir, {
            port: chrome.port,
            processIdentity: identity,
            disposition: "preserve",
          });
        }
        const owner: ManualChromeOwner = {
          chrome,
          processIdentity: identity,
          source: "launched",
          disposition: "close-on-last-lease",
          endpointAuthority,
        };

        await expect(settleManualChromeOwner(profileDir, owner, logger)).resolves.toEqual({
          status: "preserved",
        });
        expect(chrome.kill).not.toHaveBeenCalled();
        expect(endpointAuthority.release).toHaveBeenCalledOnce();
      } finally {
        await fs.rm(profileDir, { recursive: true, force: true });
      }
    },
  );

  test("does not report a requested close complete when canonical owner policy is missing", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-missing-policy-"));
    try {
      const identity = await chromeIdentity(
        profileDir,
        43_227,
        "00000000-0000-4000-8000-000000000019",
      );
      const chrome = launchedChrome(identity.pid, 45_695, identity);
      const endpointAuthority = retainedEndpointAuthority(identity, chrome.port);
      await expect(
        settleManualChromeOwner(
          profileDir,
          {
            chrome,
            processIdentity: identity,
            source: "recorded",
            disposition: "close-on-last-lease",
            endpointAuthority,
          },
          logger,
        ),
      ).resolves.toMatchObject({
        status: "unsafe",
        reason: expect.stringMatching(/requested close/i),
      });
      expect(endpointAuthority.kill).not.toHaveBeenCalled();
      expect(endpointAuthority.release).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test.each(["mismatch", "unreadable"] as const)(
    "keeps exact close authority pending when canonical owner state is %s",
    async (canonicalState) => {
      const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-pending-"));
      try {
        const identity = await chromeIdentity(
          profileDir,
          43_220,
          "00000000-0000-4000-8000-000000000011",
        );
        const chrome = launchedChrome(identity.pid, 45_688, identity);
        const endpointAuthority = retainedEndpointAuthority(identity, chrome.port);
        if (canonicalState === "mismatch") {
          await writeOracleChromeOwner(profileDir, {
            port: chrome.port + 1,
            processIdentity: identity,
            disposition: "close-on-last-lease",
          });
        } else {
          await fs.writeFile(path.join(profileDir, "oracle-chrome-owner.json"), "{", "utf8");
        }

        await expect(
          settleManualChromeOwner(
            profileDir,
            {
              chrome,
              processIdentity: identity,
              source: "recorded",
              disposition: "close-on-last-lease",
              endpointAuthority,
            },
            logger,
          ),
        ).resolves.toMatchObject({ status: "unsafe" });
        expect(chrome.kill).not.toHaveBeenCalled();
        expect(endpointAuthority.release).not.toHaveBeenCalled();
      } finally {
        await fs.rm(profileDir, { recursive: true, force: true });
      }
    },
  );

  // Exercises real crash-recoverable lease helpers whose Windows subprocess path exceeds Vitest's default budget under suite contention.
  test("hands a close-on-last-lease owner from launch to exact reuse before one final kill", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-handoff-"));
    try {
      const identity = await chromeIdentity(
        profileDir,
        43_218,
        "00000000-0000-4000-8000-000000000009",
      );
      const launchedAuthority = retainedEndpointAuthority(identity, 45_686);
      const reusedAuthority = retainedEndpointAuthority(identity, 45_686);
      const launched = launchedChrome(identity.pid, 45_686, identity, launchedAuthority);
      const config = resolveBrowserConfig({
        manualLogin: true,
        manualLoginProfileDir: profileDir,
        reuseChromeWaitMs: 0,
        maxConcurrentTabs: 2,
      });
      const firstLease = await acquireBrowserTabLease(profileDir, {
        maxConcurrentTabs: 2,
        sessionId: "run-a",
        generationId: "run-a-generation",
      });
      const secondLease = await acquireBrowserTabLease(profileDir, {
        maxConcurrentTabs: 2,
        sessionId: "run-b",
        generationId: "run-b-generation",
      });
      const acquireDeps = {
        discoverExactProfileChrome: vi.fn(async () => null),
        launch: vi.fn(async () => launched),
        verifyIdentity: vi.fn(async () => true),
      };
      const ownerA = await acquireManualChromeOwner(
        profileDir,
        config,
        logger,
        "run-a",
        acquireDeps,
      );
      const ownerB = await acquireManualChromeOwner(profileDir, config, logger, "run-b", {
        ...acquireDeps,
        retainEndpointAuthority: vi.fn(async () => reusedAuthority),
      });
      expect(ownerA.source).toBe("launched");
      expect(ownerB.source).toBe("recorded");
      expect(ownerA.disposition).toBe("close-on-last-lease");
      expect(ownerB.disposition).toBe("close-on-last-lease");

      const firstAuthority = retainBrowserTabLeaseTeardownAuthority(profileDir, firstLease, {
        ...TEST_LEASE_LIVENESS_DEPS,
        onActiveLeaseHandoff: () => releaseManualChromeOwnerEndpointAuthority(ownerA),
      });
      const secondAuthority = retainBrowserTabLeaseTeardownAuthority(profileDir, secondLease, {
        ...TEST_LEASE_LIVENESS_DEPS,
      });
      const firstTeardown = vi.fn(async () => true);
      await expect(firstAuthority.settle(firstTeardown)).resolves.toEqual({
        status: "completed",
        disposition: "active-lease-handoff",
      });
      expect(firstTeardown).not.toHaveBeenCalled();
      expect(launched.kill).not.toHaveBeenCalled();
      expect(launchedAuthority.kill).not.toHaveBeenCalled();
      expect(launchedAuthority.release).toHaveBeenCalledOnce();
      expect(reusedAuthority.kill).not.toHaveBeenCalled();
      expect(reusedAuthority.release).not.toHaveBeenCalled();

      const finalTeardown = vi.fn(async () => {
        const settlement = await settleManualChromeOwner(profileDir, ownerB, logger);
        return settlement.status === "terminated";
      });
      await expect(secondAuthority.settle(finalTeardown)).resolves.toEqual({
        status: "completed",
        disposition: "teardown-completed",
      });
      expect(finalTeardown).toHaveBeenCalledOnce();
      expect(launched.kill).not.toHaveBeenCalled();
      expect(reusedAuthority.kill).toHaveBeenCalledOnce();
      expect(launchedAuthority.kill).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("preserves a launched owner when exact termination is unsafe", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-owner-unsafe-settlement-"));
    try {
      const identity = await chromeIdentity(
        profileDir,
        43_217,
        "00000000-0000-4000-8000-000000000008",
      );
      const endpointAuthority = retainedEndpointAuthority(identity, 45_685);
      const chrome = launchedChrome(identity.pid, 45_685, identity, endpointAuthority);
      await writeOracleChromeOwner(profileDir, {
        port: chrome.port,
        processIdentity: identity,
        disposition: "close-on-last-lease",
      });
      vi.mocked(endpointAuthority.kill).mockResolvedValue({
        status: "unsafe",
        pid: identity.pid,
        reason: "exact process handle was lost",
      });

      await expect(
        settleManualChromeOwner(
          profileDir,
          {
            chrome,
            processIdentity: identity,
            source: "launched",
            disposition: "close-on-last-lease",
            endpointAuthority,
          },
          logger,
        ),
      ).resolves.toEqual({ status: "unsafe", reason: "exact process handle was lost" });
      expect(endpointAuthority.kill).toHaveBeenCalledOnce();
      expect(chrome.kill).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });
});
