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
  inspectChromeProfileDirectoryUse,
  revalidateChromeProfileDirectoryUse,
} from "../../src/browser/chromeProfileDirectoryUse.js";
import { inspectChromeProcessesForLaunchClaimFromProcessList } from "../../src/browser/chromeProcessDiscovery.js";
import { readChromeProcessSnapshot } from "../../src/browser/chromeProcessProbe.js";
import type { ProfileDirectoryIdentity } from "../../src/browser/profileState.js";
import { resolveWindowsPowerShellExecutable } from "../../src/windowsSystemExecutable.js";

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
  test("re-inspects after unsafe endpoint teardown and succeeds only after exact exit is proven", async () => {
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
    const retainEndpointAuthority = vi.fn(async () => ({
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/exact-generation",
      kill: retainedControlKill,
      runExactOperation: vi.fn(),
      release: vi.fn(async () => undefined),
    }));
    const kill = await createLaunchedChromeControlKillForTest(
      {
        host: "127.0.0.1",
        port: 9222,
        userDataDir: identity.profileDirectory.canonicalPath,
        processIdentity: identity,
      },
      { inspectProcessIdentity, retainEndpointAuthority },
    );

    await expect(kill()).resolves.toMatchObject({ status: "unsafe" });
    const stopped = await kill();
    const cached = await kill();
    expect(stopped).toEqual({ status: "already-stopped", pid: identity.pid });
    expect(cached).toBe(stopped);
    expect(inspectProcessIdentity).toHaveBeenCalledTimes(3);
    expect(retainEndpointAuthority).toHaveBeenCalledOnce();
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

describe("Darwin Chrome process command parsing", () => {
  test("accepts an unquoted final spaced profile from its claimed launch without honoring a quoted decoy", () => {
    const executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const userDataDir = "/private/var/folders/oracle/profile with spaces";
    const claim = {
      version: 1 as const,
      generationId: "00000000-0000-4000-8000-000000000001",
      nonce: "00000000-0000-4000-8000-000000000002",
    };

    expect(
      inspectChromeProcessesForLaunchClaimFromProcessList(
        `4321 ${executable} --remote-debugging-port=9222 "quoted --user-data-dir=/private/decoy" --oracle-launch-claim=${claim.generationId}:${claim.nonce} --user-data-dir=${userDataDir}\n`,
        userDataDir,
        claim,
        null,
        "darwin",
      ),
    ).toEqual({
      exactMatches: [{ pid: 4321, port: 9222 }],
      conflictingProfilePids: [],
    });
  });
});

describe("Linux Chrome procfs snapshot", () => {
  const pid = 4321;
  const bootId = "11111111-1111-4111-8111-111111111111";
  const executablePath = "/opt/Google Chrome/chrome";
  const commandTokens = [
    executablePath,
    "--user-data-dir=/tmp/profile with spaces",
    "--enable-features=Value With Spaces",
  ];

  const procStat = (startTicks: string) => {
    const fields = Array.from({ length: 20 }, (_, index) => String(10_000 + index));
    fields[0] = "S";
    fields[19] = startTicks;
    return `${pid} (chrome) ${fields.join(" ")}`;
  };

  const syntheticProcfs = ({
    statReads = [procStat("987654"), procStat("987654")],
    bootIdReads = [bootId, bootId],
    executableReads = [executablePath, executablePath],
    commandLineReads = [commandTokens.join("\0") + "\0", commandTokens.join("\0") + "\0"],
  }: {
    statReads?: string[];
    bootIdReads?: string[];
    executableReads?: string[];
    commandLineReads?: string[];
  } = {}) => ({
    readFile: vi.fn(async (filePath: string) => {
      if (filePath.endsWith("/stat")) return statReads.shift() ?? "";
      if (filePath === "/proc/sys/kernel/random/boot_id") return bootIdReads.shift() ?? "";
      if (filePath.endsWith("/cmdline")) return commandLineReads.shift() ?? "";
      throw new Error(`Unexpected procfs read: ${filePath}`);
    }),
    readlink: vi.fn(async (filePath: string) => {
      if (filePath.endsWith("/exe")) return executableReads.shift() ?? "";
      throw new Error(`Unexpected procfs link: ${filePath}`);
    }),
  });

  test("captures a stable exact Linux generation and NUL-delimited spaced argv", async () => {
    const procfs = syntheticProcfs();

    await expect(readChromeProcessSnapshot(pid, "linux", { linuxProcfs: procfs })).resolves.toEqual(
      {
        pid,
        processStartTime: `linux:${bootId}:987654`,
        executablePath,
        commandLine:
          '"/opt/Google Chrome/chrome" "--user-data-dir=/tmp/profile with spaces" "--enable-features=Value With Spaces"',
        commandTokens,
      },
    );
    expect(procfs.readlink).toHaveBeenCalledTimes(2);
    expect(procfs.readFile).toHaveBeenCalledTimes(6);
  });

  test("fails closed when the process start ticks change during capture", async () => {
    await expect(
      readChromeProcessSnapshot(pid, "linux", {
        linuxProcfs: syntheticProcfs({
          statReads: [procStat("987654"), procStat("987655")],
        }),
      }),
    ).resolves.toBeNull();
  });

  test("fails closed when the system boot identity changes during capture", async () => {
    await expect(
      readChromeProcessSnapshot(pid, "linux", {
        linuxProcfs: syntheticProcfs({
          bootIdReads: [bootId, "22222222-2222-4222-8222-222222222222"],
        }),
      }),
    ).resolves.toBeNull();
  });

  test.each([
    ["executable", { executableReads: [executablePath, "/opt/Chromium/chromium"] }],
    [
      "command line",
      {
        commandLineReads: [
          commandTokens.join("\0") + "\0",
          `${executablePath}\0--user-data-dir=/tmp/replacement\0`,
        ],
      },
    ],
  ])("fails closed when the procfs %s changes during capture", async (_name, mutation) => {
    await expect(
      readChromeProcessSnapshot(pid, "linux", { linuxProcfs: syntheticProcfs(mutation) }),
    ).resolves.toBeNull();
  });

  test("fails closed for a malformed procfs stat record", async () => {
    await expect(
      readChromeProcessSnapshot(pid, "linux", {
        linuxProcfs: syntheticProcfs({
          statReads: ["4321 (chrome) S 1", procStat("987654")],
        }),
      }),
    ).resolves.toBeNull();
  });
});

describe("physical Chrome profile use authority", () => {
  test.each([
    ["Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    ["Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    ["Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
  ])("detects Darwin %s using an unquoted spaced profile path", async (_family, executable) => {
    const aliasPath = "/var/folders/oracle/profile with spaces";
    const expected = Object.freeze({
      version: 2 as const,
      platform: "darwin" as const,
      canonicalPath: "/private/var/folders/oracle/profile with spaces",
      device: "7",
      inode: "99",
      birthtimeNs: "3",
    }) satisfies ProfileDirectoryIdentity;
    const captureProfileIdentity = vi.fn(async (candidate: string) => {
      expect(candidate).toBe(aliasPath);
      return expected;
    });

    const inspection = await inspectChromeProfileDirectoryUse(expected, {
      platform: "darwin",
      listProcesses: async () => [
        {
          pid: 4321,
          commandLine: `${executable} --user-data-dir=${aliasPath} --remote-debugging-port=9222`,
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
    const initial = await inspectChromeProfileDirectoryUse(expected, deps);
    expect(initial.status).toBe("unused");
    if (initial.status !== "unused") throw new Error("Expected an unused profile proof");

    await expect(
      revalidateChromeProfileDirectoryUse(expected, initial, deps),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringMatching(/changed generation/i),
    });
  });

  test("ignores a hostile PATH when enumerating Darwin processes", async () => {
    const expected = Object.freeze({
      version: 2 as const,
      platform: "darwin" as const,
      canonicalPath: "/private/var/folders/oracle/profile",
      device: "7",
      inode: "99",
      birthtimeNs: "3",
    }) satisfies ProfileDirectoryIdentity;
    const attackerPs = vi.fn(async () => ({ stdout: "999 fake-attacker-process\n" }));
    const execute = vi.fn(async (file: string) => {
      if (file === "ps") return attackerPs();
      if (file !== "/bin/ps") throw new Error(`Unexpected process probe: ${file}`);
      return { stdout: "123 /usr/bin/node server.js\n" };
    });

    await expect(
      inspectChromeProfileDirectoryUse(expected, { platform: "darwin", execute }),
    ).resolves.toEqual({ status: "unused", candidates: [] });
    expect(attackerPs).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("/bin/ps", ["-axww", "-o", "pid=", "-o", "command="]);
  });

  test("uses only the OS-rooted System PowerShell for Windows Chrome enumeration", async () => {
    const expected = Object.freeze({
      version: 2 as const,
      platform: "win32" as const,
      canonicalPath: String.raw`C:\Users\Oracle\chrome-profile`,
      device: "7",
      inode: "99",
      birthtimeNs: "3",
    }) satisfies ProfileDirectoryIdentity;
    const attackerPowerShell = vi.fn(async () => ({ stdout: "999:\n" }));
    const trustedPowerShell = resolveWindowsPowerShellExecutable();
    const execute = vi.fn(async (file: string, _args: string[]) => {
      if (file === "powershell.exe") return attackerPowerShell();
      if (file !== trustedPowerShell) throw new Error(`Unexpected process probe: ${file}`);
      return { stdout: "" };
    });

    await expect(
      inspectChromeProfileDirectoryUse(expected, {
        platform: "win32",
        execute,
      }),
    ).resolves.toEqual({ status: "unused", candidates: [] });
    expect(attackerPowerShell).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toBe(trustedPowerShell);
    expect(execute.mock.calls[0]?.[1]).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      expect.stringContaining(
        "Where-Object { $_.Name -match '^(chrome|chromium|msedge|brave)\\.exe$' }",
      ),
    ]);
  });

  test.each([
    ["Edge", 4_321, String.raw`C:\Program Files\Microsoft\Edge\Application\msedge.exe`],
    [
      "Brave",
      4_322,
      String.raw`C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`,
    ],
  ])("enumerates the bounded Windows %s main process", async (_family, pid, executablePath) => {
    const expected = Object.freeze({
      version: 2 as const,
      platform: "win32" as const,
      canonicalPath: String.raw`C:\Users\Oracle\profile with spaces`,
      device: "7",
      inode: "99",
      birthtimeNs: "3",
    }) satisfies ProfileDirectoryIdentity;
    const commandLine = `"${executablePath}" --user-data-dir="${expected.canonicalPath}"`;
    const trustedPowerShell = resolveWindowsPowerShellExecutable();
    const execute = vi.fn(async (file: string, args: string[]) => {
      expect(file).toBe(trustedPowerShell);
      expect(args[3]).toContain(
        "Where-Object { $_.Name -match '^(chrome|chromium|msedge|brave)\\.exe$' }",
      );
      return { stdout: `${pid}:${Buffer.from(commandLine, "utf8").toString("base64")}\n` };
    });
    const captureProfileIdentity = vi.fn(async (candidate: string) => {
      expect(candidate).toBe(expected.canonicalPath.toLowerCase());
      return expected;
    });

    await expect(
      inspectChromeProfileDirectoryUse(expected, {
        platform: "win32",
        execute,
        readProcessGeneration: async () => "win32:2026-08-06T12:00:00.0000000Z",
        captureProfileIdentity,
      }),
    ).resolves.toEqual({
      status: "in-use",
      candidates: [
        {
          pid,
          processGeneration: "win32:2026-08-06T12:00:00.0000000Z",
          profileDirectory: expected,
        },
      ],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(captureProfileIdentity).toHaveBeenCalledOnce();
  });

  test("fails closed when the trusted process probe is unavailable", async () => {
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
      inspectChromeProfileDirectoryUse(expected, {
        platform: "darwin",
        execute,
        trustedProcessProbe: null,
      }),
    ).resolves.toEqual({
      status: "unavailable",
      candidates: [],
      reason: "Complete Chrome process enumeration failed",
    });
    expect(execute).not.toHaveBeenCalled();
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
      inspectChromeProfileDirectoryUse(expected, {
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
