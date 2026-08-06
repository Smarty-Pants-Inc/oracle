import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import type { StableChromeProcessHandle } from "../../src/browser/chromeLifecycle.js";
import {
  processIdentity,
  retainedChildProcess,
  resolveLocalChromeLaunchRoute,
  syntheticProfileIdentity,
} from "./chromeLifecycleTestHelpers.js";
import {
  inspectChromeProfileDirectoryUseForTest,
  revalidateChromeProfileDirectoryUseForTest,
  type ProfileDirectoryIdentity,
} from "../../src/browser/profileState.js";

describe("stable Chrome process authority", () => {
  test("carries retained endpoint release authority into a current standard launch", async () => {
    // Dynamic imports keep this launch assertion bound to Vitest's hoisted CDP mock.
    const { launchChrome } = await import("../../src/browser/chromeLifecycle.js");
    const { resolveBrowserConfig } = await import("../../src/browser/config.js");
    const profile = syntheticProfileIdentity(path.join(os.tmpdir(), "oracle-standard-profile"));
    const identity = processIdentity(
      profile.canonicalPath,
      5678,
      "22222222-2222-4222-8222-222222222222",
    );
    const child = retainedChildProcess(identity.pid);
    const legacyPidKill = vi.fn(async () => undefined);
    const standardLaunch = vi.fn(async () => ({
      pid: identity.pid,
      port: 9222,
      process: child,
      remoteDebuggingPipes: null,
      kill: legacyPidKill,
    }));
    const exactControlKill = vi.fn(async () => ({
      status: "stopped" as const,
      pid: identity.pid,
      signal: "CONTROL_CHANNEL" as const,
    }));
    const endpointRelease = vi.fn(async () => undefined);
    const retainedEndpointAuthority = {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/standard-launch",
      kill: exactControlKill,
      release: endpointRelease,
    };
    const retainEndpointAuthority = vi.fn(async () => retainedEndpointAuthority);
    const captureProcessIdentity = vi.fn(async () => identity);

    const launched = await launchChrome(
      { ...resolveBrowserConfig({ debugPort: 9222 }), hideWindow: false },
      profile.canonicalPath,
      vi.fn<(message: string) => void>(),
      {
        standardLaunch: standardLaunch as never,
        resolveLaunchRoute: resolveLocalChromeLaunchRoute,
        captureProfileIdentity: async () => profile,
        launchClaim: identity.launchClaim,
        captureProcessIdentity,
        inspectProcessIdentity: vi.fn(async () => "current" as const),
        retainEndpointAuthority,
        writeOwner: vi.fn(async () => undefined),
      },
    );
    expect(standardLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        chromeFlags: expect.arrayContaining([
          `--oracle-launch-claim=${identity.launchClaim.generationId}:${identity.launchClaim.nonce}`,
        ]),
      }),
    );
    expect(captureProcessIdentity).toHaveBeenCalledWith(
      profile.canonicalPath,
      identity.pid,
      identity.launchClaim,
    );

    await expect(launched.kill()).resolves.toMatchObject({
      status: "stopped",
      pid: identity.pid,
      signal: "CONTROL_CHANNEL",
    });
    expect(retainEndpointAuthority).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      userDataDir: profile.canonicalPath,
      processIdentity: identity,
    });
    expect(launched.endpointAuthority).toMatchObject({
      browserWSEndpoint: retainedEndpointAuthority.browserWSEndpoint,
      release: endpointRelease,
    });
    expect(launched.endpointAuthority?.kill).toBe(launched.kill);
    expect(exactControlKill).toHaveBeenCalledOnce();
    expect(endpointRelease).toHaveBeenCalledOnce();
    expect(child.signalCalls).toEqual([]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(legacyPidKill).not.toHaveBeenCalled();
  });

  test("rolls back before owner publication when endpoint release authority is initially unavailable", async () => {
    // Dynamic imports keep this launch assertion bound to Vitest's hoisted CDP mock.
    const { launchChrome } = await import("../../src/browser/chromeLifecycle.js");
    const { resolveBrowserConfig } = await import("../../src/browser/config.js");
    const profile = syntheticProfileIdentity(
      path.join(os.tmpdir(), "oracle-authority-gate-profile"),
    );
    const identity = processIdentity(
      profile.canonicalPath,
      5679,
      "22222222-2222-4222-8222-222222222223",
    );
    const child = retainedChildProcess(identity.pid);
    const standardLaunch = vi.fn(async () => ({
      pid: identity.pid,
      port: 9223,
      process: child,
      remoteDebuggingPipes: null,
      kill: vi.fn(async () => undefined),
    }));
    const exactControlKill = vi.fn(async () => ({
      status: "stopped" as const,
      pid: identity.pid,
      signal: "CONTROL_CHANNEL" as const,
    }));
    const rollbackRelease = vi.fn(async () => undefined);
    const retainEndpointAuthority = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient endpoint retention failure"))
      .mockResolvedValueOnce({
        browserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/rollback",
        kill: exactControlKill,
        release: rollbackRelease,
      });
    const writeOwner = vi.fn(async () => undefined);

    await expect(
      launchChrome(
        { ...resolveBrowserConfig({ debugPort: 9223 }), hideWindow: false },
        profile.canonicalPath,
        vi.fn<(message: string) => void>(),
        {
          standardLaunch: standardLaunch as never,
          resolveLaunchRoute: resolveLocalChromeLaunchRoute,
          captureProfileIdentity: async () => profile,
          launchClaim: identity.launchClaim,
          captureProcessIdentity: vi.fn(async () => identity),
          inspectProcessIdentity: vi.fn(async () => "current" as const),
          retainEndpointAuthority,
          writeOwner,
        },
      ),
    ).rejects.toThrow(/did not retain exact endpoint release authority/i);
    expect(retainEndpointAuthority).toHaveBeenCalledTimes(2);
    expect(exactControlKill).toHaveBeenCalledOnce();
    expect(rollbackRelease).toHaveBeenCalledOnce();
    expect(writeOwner).not.toHaveBeenCalled();
  });

  test("observes the original child exit without signaling a reused pid", async () => {
    const { createStableChildProcessChromeKill } =
      await import("../../src/browser/chromeLifecycle.js");
    const child = retainedChildProcess(6788);
    const exactControlKill = vi.fn(async () => ({
      status: "unsafe" as const,
      pid: child.pid,
      reason: "would target the reused pid",
    }));
    child.markExited();

    await expect(createStableChildProcessChromeKill(child, exactControlKill)()).resolves.toEqual({
      status: "already-stopped",
      pid: 6788,
    });
    expect(exactControlKill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.signalCalls).toEqual([]);
  });

  test("retries endpoint release when the retained child has already exited", async () => {
    // Dynamic import keeps this authority assertion bound to Vitest's hoisted CDP mock.
    const { createEndpointBoundChildProcessChromeKill } =
      await import("../../src/browser/chromeLifecycle.js");
    const child = retainedChildProcess(6787);
    const exactControlKill = vi.fn(async () => ({
      status: "unsafe" as const,
      pid: child.pid,
      reason: "must not target an exited child",
    }));
    const release = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient endpoint release failure"))
      .mockResolvedValueOnce(undefined);
    child.markExited();
    const kill = createEndpointBoundChildProcessChromeKill(child, exactControlKill, { release });

    await expect(kill()).resolves.toMatchObject({
      status: "unsafe",
      pid: child.pid,
      reason: expect.stringMatching(/endpoint release failed/i),
    });
    await expect(kill()).resolves.toEqual({ status: "already-stopped", pid: child.pid });
    await expect(kill()).resolves.toEqual({ status: "already-stopped", pid: child.pid });
    expect(exactControlKill).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(2);
  });

  test("does not treat a retained handle without a process id as safely stopped", async () => {
    const { createStableChildProcessChromeKill } =
      await import("../../src/browser/chromeLifecycle.js");
    const signal = vi.fn(() => true);
    const child = {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: signal,
    } satisfies StableChromeProcessHandle & { kill: typeof signal };

    await expect(
      createStableChildProcessChromeKill(
        child,
        vi.fn(async () => ({ status: "already-stopped" as const })),
      )(),
    ).resolves.toMatchObject({
      status: "unsafe",
      reason: expect.stringMatching(/no stable process id/i),
    });
    expect(signal).not.toHaveBeenCalled();
  });

  test("retries unsafe exact control teardown and caches only its safe terminal outcome", async () => {
    const { createStableChildProcessChromeKill } =
      await import("../../src/browser/chromeLifecycle.js");
    const child = retainedChildProcess(6789);
    const stopped = {
      status: "stopped" as const,
      pid: child.pid,
      signal: "CONTROL_CHANNEL" as const,
    };
    const exactControlKill = vi
      .fn()
      .mockResolvedValueOnce({
        status: "unsafe" as const,
        pid: child.pid,
        reason: "exact exit not proven yet",
      })
      .mockResolvedValueOnce(stopped);
    const kill = createStableChildProcessChromeKill(child, exactControlKill);

    await expect(kill()).resolves.toMatchObject({ status: "unsafe" });
    const safe = await kill();
    const cached = await kill();
    expect(safe).toBe(stopped);
    expect(cached).toBe(stopped);
    expect(exactControlKill).toHaveBeenCalledTimes(2);
    expect(child.kill).not.toHaveBeenCalled();
  });
  test("re-inspects after unsafe teardown and succeeds only after exact exit is proven", async () => {
    const { createLaunchedChromeControlKillForTest } =
      await import("../../src/browser/chromeLifecycle.js");
    const identity = processIdentity(
      path.join(os.tmpdir(), "oracle-control-retry-profile"),
      6791,
      "22222222-2222-4222-8222-222222222223",
    );
    const inspectProcessIdentity = vi
      .fn()
      .mockResolvedValueOnce("current" as const)
      .mockResolvedValueOnce("current" as const)
      .mockResolvedValueOnce("exited" as const);
    const retainedControlKill = vi.fn(async () => ({
      status: "unsafe" as const,
      pid: identity.pid,
      reason: "Browser.close completed but exact exit is not visible yet",
    }));
    const retainControlChannel = vi.fn(async () => retainedControlKill);
    const kill = await createLaunchedChromeControlKillForTest(
      {
        host: "127.0.0.1",
        port: 9222,
        userDataDir: identity.profileDirectory.canonicalPath,
        processIdentity: identity,
      },
      { inspectProcessIdentity, retainControlChannel },
    );

    await expect(kill()).resolves.toMatchObject({ status: "unsafe" });
    const stopped = await kill();
    const cached = await kill();
    expect(stopped).toEqual({ status: "already-stopped", pid: identity.pid });
    expect(cached).toBe(stopped);
    expect(inspectProcessIdentity).toHaveBeenCalledTimes(3);
    expect(retainControlChannel).toHaveBeenCalledOnce();
    expect(retainedControlKill).toHaveBeenCalledOnce();
  });

  test("clears a rejected in-flight exact teardown so a retry can succeed", async () => {
    const { createStableChildProcessChromeKill } =
      await import("../../src/browser/chromeLifecycle.js");
    const child = retainedChildProcess(6790);
    const exactControlKill = vi
      .fn()
      .mockRejectedValueOnce(new Error("control transport reset"))
      .mockResolvedValueOnce({
        status: "already-stopped" as const,
        pid: child.pid,
      });
    const kill = createStableChildProcessChromeKill(child, exactControlKill);

    await expect(kill()).rejects.toThrow("control transport reset");
    await expect(kill()).resolves.toEqual({ status: "already-stopped", pid: child.pid });
    expect(exactControlKill).toHaveBeenCalledTimes(2);
    expect(child.kill).not.toHaveBeenCalled();
  });

  test("preserves the launched process when identity capture cannot establish control authority", async () => {
    const { launchChrome } = await import("../../src/browser/chromeLifecycle.js");
    const { resolveBrowserConfig } = await import("../../src/browser/config.js");
    const profile = syntheticProfileIdentity(path.join(os.tmpdir(), "oracle-invalid-profile"));
    const child = retainedChildProcess(6789);
    const captureError = new Error("identity unavailable");
    await expect(
      launchChrome(
        { ...resolveBrowserConfig({ debugPort: 9222 }), hideWindow: false },
        profile.canonicalPath,
        vi.fn<(message: string) => void>(),
        {
          standardLaunch: vi.fn(async () => ({
            pid: 6789,
            port: 9222,
            process: child,
            remoteDebuggingPipes: null,
            kill: vi.fn(async () => undefined),
          })) as never,
          resolveLaunchRoute: resolveLocalChromeLaunchRoute,
          captureProfileIdentity: async () => profile,
          captureProcessIdentity: vi.fn(async () => {
            throw captureError;
          }),
        },
      ),
    ).rejects.toMatchObject({
      name: "AggregateError",
      errors: [
        captureError,
        expect.objectContaining({
          message: expect.stringMatching(/control authority.*unavailable/i),
        }),
      ],
    });
    expect(child.signalCalls).toEqual([]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  test("preserves the unsafe outcome when persistence rollback lacks stable authority", async () => {
    const { createOwnerBoundChromeKill } = await import("../../src/browser/chromeLifecycle.js");
    const identity = processIdentity(
      path.join(os.tmpdir(), "oracle-rollback-profile"),
      8902,
      "44444444-4444-4444-8444-444444444445",
    );
    const persistenceError = new Error("disk full");
    const stableKill = vi.fn(async () => ({
      status: "unsafe" as const,
      pid: identity.pid,
      reason: "retained handle unavailable",
    }));
    await expect(
      createOwnerBoundChromeKill(
        identity.profileDirectory.canonicalPath,
        { port: 9222, processIdentity: identity, disposition: "close-on-last-lease" },
        stableKill,
        {
          writeOwner: vi.fn(async () => {
            throw persistenceError;
          }),
        },
      ),
    ).rejects.toMatchObject({
      name: "AggregateError",
      errors: [
        persistenceError,
        expect.objectContaining({ message: "retained handle unavailable" }),
      ],
    });
    expect(stableKill).toHaveBeenCalledOnce();
  });

  test("returns the retained stable kill after identity persistence", async () => {
    const { createOwnerBoundChromeKill } = await import("../../src/browser/chromeLifecycle.js");
    const identity = processIdentity(
      path.join(os.tmpdir(), "oracle-partial-profile"),
      9012,
      "55555555-5555-4555-8555-555555555555",
    );
    const writeOwner = vi.fn(async () => undefined);
    const stableKill = vi.fn(async () => ({
      status: "stopped" as const,
      pid: identity.pid,
      signal: "SIGTERM" as const,
    }));
    const kill = await createOwnerBoundChromeKill(
      identity.profileDirectory.canonicalPath,
      { port: 9222, processIdentity: identity, disposition: "close-on-last-lease" },
      stableKill,
      { writeOwner },
    );
    expect(stableKill).not.toHaveBeenCalled();
    await expect(kill()).resolves.toMatchObject({ status: "stopped", pid: identity.pid });
    expect(writeOwner).toHaveBeenCalledWith(identity.profileDirectory.canonicalPath, {
      port: 9222,
      processIdentity: identity,
      disposition: "close-on-last-lease",
    });
  });
});

describe("physical Chrome profile use authority", () => {
  test("detects Darwin /var and /private/var as the same physical profile", async () => {
    const aliasPath = "/var/folders/oracle/profile";
    const expected = Object.freeze({
      version: 2 as const,
      platform: "darwin" as const,
      canonicalPath: "/private/var/folders/oracle/profile",
      device: "7",
      inode: "99",
      birthtimeNs: "3",
    }) satisfies ProfileDirectoryIdentity;
    const captureProfileIdentity = vi.fn(async (candidate: string) => {
      expect(candidate).toBe(aliasPath);
      return expected;
    });

    const inspection = await inspectChromeProfileDirectoryUseForTest(expected, {
      platform: "darwin",
      listProcesses: async () => [
        {
          pid: 4321,
          commandLine:
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome " +
            `--user-data-dir=${aliasPath}`,
        },
      ],
      readProcessGeneration: async () => "darwin-audit-pidversion:7001",
      captureProfileIdentity,
    });

    expect(inspection).toEqual({
      status: "in-use",
      candidates: [
        {
          pid: 4321,
          processGeneration: "darwin-audit-pidversion:7001",
          profileDirectory: expected,
        },
      ],
    });
    expect(captureProfileIdentity).toHaveBeenCalledTimes(1);
  });

  test("fails closed when a retained candidate generation becomes incomparable", async () => {
    const expected = Object.freeze({
      version: 2 as const,
      platform: "darwin" as const,
      canonicalPath: "/private/var/folders/oracle/profile",
      device: "7",
      inode: "99",
      birthtimeNs: "3",
    }) satisfies ProfileDirectoryIdentity;
    const unrelated = Object.freeze({
      ...expected,
      canonicalPath: "/private/var/folders/oracle/other",
      inode: "100",
    });
    const processList = [
      {
        pid: 4322,
        commandLine:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome " +
          "--user-data-dir=/private/var/folders/oracle/other",
      },
    ];
    const generations = [
      "darwin-audit-pidversion:7001",
      "darwin-audit-pidversion:7001",
      "darwin-kernel-start:1785945427:287123",
      "darwin-kernel-start:1785945427:287123",
    ];
    const deps = {
      platform: "darwin" as const,
      listProcesses: async () => processList,
      readProcessGeneration: async () => generations.shift() ?? null,
      captureProfileIdentity: async () => unrelated,
    };
    const initial = await inspectChromeProfileDirectoryUseForTest(expected, deps);
    expect(initial.status).toBe("unused");
    if (initial.status !== "unused") throw new Error("Expected an unused profile proof");

    await expect(
      revalidateChromeProfileDirectoryUseForTest(expected, initial, deps),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringMatching(/changed generation/i),
    });
  });

  test("enumerates all platform processes before proving a profile unused", async () => {
    const expected = Object.freeze({
      version: 2 as const,
      platform: "darwin" as const,
      canonicalPath: "/private/var/folders/oracle/profile",
      device: "7",
      inode: "99",
      birthtimeNs: "3",
    }) satisfies ProfileDirectoryIdentity;
    const execute = vi.fn(async () => ({ stdout: "123 /usr/bin/node server.js\n" }));

    await expect(
      inspectChromeProfileDirectoryUseForTest(expected, { platform: "darwin", execute }),
    ).resolves.toEqual({ status: "unused", candidates: [] });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("ps", ["-axww", "-o", "pid=", "-o", "command="]);
  });

  test("fails closed when a Chrome candidate profile identity is unreadable", async () => {
    const expected = Object.freeze({
      version: 2 as const,
      platform: "darwin" as const,
      canonicalPath: "/private/var/folders/oracle/profile",
      device: "7",
      inode: "99",
      birthtimeNs: "3",
    }) satisfies ProfileDirectoryIdentity;

    await expect(
      inspectChromeProfileDirectoryUseForTest(expected, {
        platform: "darwin",
        listProcesses: async () => [
          {
            pid: 4323,
            commandLine:
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome " +
              "--user-data-dir=/var/folders/oracle/profile",
          },
        ],
        readProcessGeneration: async () => "darwin-audit-pidversion:7003",
        captureProfileIdentity: async () => {
          throw new Error("stat denied");
        },
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringMatching(/unreadable/i),
    });
  });
});
