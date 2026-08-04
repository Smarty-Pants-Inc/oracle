import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type {
  ChromeLaunchResult,
  StableChromeProcessHandle,
} from "../../src/browser/chromeLifecycle.js";
import type {
  ChromeProcessIdentity,
  ProfileDirectoryIdentity,
} from "../../src/browser/profileState.js";

const cdpNewMock = vi.fn();
const cdpCloseMock = vi.fn();
const cdpListMock = vi.fn();
const cdpMock = Object.assign(vi.fn(), {
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  New: cdpNewMock,
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  Close: cdpCloseMock,
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  List: cdpListMock,
});

const resolveLocalChromeLaunchRoute = () => ({
  connectHost: null,
  debugBindAddress: null,
  usePatchedLauncher: false,
});

function profileIdentity(userDataDir: string): ProfileDirectoryIdentity {
  const resolvedPath = path.resolve(userDataDir);
  const canonicalPath = existsSync(resolvedPath) ? realpathSync(resolvedPath) : resolvedPath;
  const physical = existsSync(canonicalPath) ? statSync(canonicalPath, { bigint: true }) : null;
  return {
    version: 1,
    platform: process.platform,
    canonicalPath,
    device: physical?.dev.toString() ?? "1",
    inode: physical?.ino.toString() ?? "2",
  };
}

function processIdentity(
  userDataDir: string,
  pid: number,
  launchNonce: string,
): ChromeProcessIdentity {
  const profileDirectory = profileIdentity(userDataDir);
  return {
    pid,
    processStartTime: `launch-${pid}`,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    normalizedUserDataDir: profileDirectory.canonicalPath,
    launchNonce,
    profileDirectory,
  };
}

function retainedChildProcess(
  pid: number,
): StableChromeProcessHandle & { signalCalls: NodeJS.Signals[] } {
  const emitter = new EventEmitter();
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
      state.signalCode = signal;
      queueMicrotask(() => emitter.emit("exit"));
      return true;
    }),
    once: (event, listener) => emitter.once(event, listener),
    removeListener: (event, listener) => emitter.removeListener(event, listener),
  };
}

function chromeLaunchResult(
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

vi.mock("chrome-remote-interface", () => ({ default: cdpMock }));

vi.doMock("../../src/browser/profileState.js", async () => {
  const original = await vi.importActual<typeof import("../../src/browser/profileState.js")>(
    "../../src/browser/profileState.js",
  );
  return {
    ...original,
    cleanupStaleProfileState: vi.fn(async () => true),
  };
});

describe("hidden macOS Chrome launch", () => {
  test("retains the exact hidden-launch control authority", async () => {
    const { launchChrome } = await import("../../src/browser/chromeLifecycle.js");
    const { resolveBrowserConfig } = await import("../../src/browser/config.js");
    const profile = profileIdentity("/tmp/oracle-hidden-profile");
    const identity = processIdentity(
      profile.canonicalPath,
      4321,
      "11111111-1111-4111-8111-111111111111",
    );
    const stableKill = vi.fn(async () => ({
      status: "stopped" as const,
      pid: identity.pid,
      signal: "CONTROL_CHANNEL" as const,
    }));
    const hiddenMacLaunch = vi.fn(async () => chromeLaunchResult(identity, stableKill));
    const standardLaunch = vi.fn();
    const writeProcessIdentity = vi.fn(async () => undefined);
    const logger = vi.fn<(message: string) => void>();

    const launched = await launchChrome(
      resolveBrowserConfig({ hideWindow: true, debugPort: 9222 }),
      profile.canonicalPath,
      logger,
      {
        platform: "darwin",
        resolveLaunchRoute: resolveLocalChromeLaunchRoute,
        hiddenMacLaunch,
        standardLaunch,
        captureProfileIdentity: async () => profile,
        writeProcessIdentity,
      },
    );

    expect(hiddenMacLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ userDataDir: profile.canonicalPath, requestedPort: 9222 }),
    );
    expect(standardLaunch).not.toHaveBeenCalled();
    expect(writeProcessIdentity).toHaveBeenCalledWith(profile.canonicalPath, identity);
    await expect(launched.kill()).resolves.toMatchObject({
      status: "stopped",
      signal: "CONTROL_CHANNEL",
    });
    expect(stableKill).toHaveBeenCalledOnce();
  });

  test("builds an open command that is hidden, backgrounded, and isolated", async () => {
    const { buildHiddenMacChromeOpenArgs } = await import("../../src/browser/chromeLifecycle.js");
    expect(
      buildHiddenMacChromeOpenArgs("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
        "--remote-debugging-port=9222",
        "about:blank",
      ]),
    ).toEqual([
      "-g",
      "-j",
      "-n",
      "/Applications/Google Chrome.app",
      "--args",
      "--remote-debugging-port=9222",
      "about:blank",
    ]);
  });

  test("fails closed when hidden headful launch cannot be guaranteed", async () => {
    const { launchChrome } = await import("../../src/browser/chromeLifecycle.js");
    const { resolveBrowserConfig } = await import("../../src/browser/config.js");
    const profile = profileIdentity("/tmp/oracle-hidden-profile");
    await expect(
      launchChrome(
        resolveBrowserConfig({ hideWindow: true }),
        profile.canonicalPath,
        vi.fn<(message: string) => void>(),
        { platform: "linux", captureProfileIdentity: async () => profile },
      ),
    ).rejects.toThrow(/use --remote-chrome/i);
  });
});

describe("stable Chrome process authority", () => {
  test("terminates a current launch through its retained ChildProcess handle", async () => {
    const { launchChrome } = await import("../../src/browser/chromeLifecycle.js");
    const { resolveBrowserConfig } = await import("../../src/browser/config.js");
    const profile = profileIdentity("/tmp/oracle-standard-profile");
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

    const launched = await launchChrome(
      { ...resolveBrowserConfig({ debugPort: 9222 }), hideWindow: false },
      profile.canonicalPath,
      vi.fn<(message: string) => void>(),
      {
        standardLaunch: standardLaunch as never,
        resolveLaunchRoute: resolveLocalChromeLaunchRoute,
        captureProfileIdentity: async () => profile,
        captureProcessIdentity: vi.fn(async () => identity),
        writeProcessIdentity: vi.fn(async () => undefined),
      },
    );

    await expect(launched.kill()).resolves.toMatchObject({
      status: "stopped",
      pid: identity.pid,
      signal: "SIGTERM",
    });
    expect(child.signalCalls).toEqual(["SIGTERM"]);
    expect(legacyPidKill).not.toHaveBeenCalled();
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
      once: vi.fn(),
      removeListener: vi.fn(),
    } satisfies StableChromeProcessHandle;

    await expect(createStableChildProcessChromeKill(child)()).resolves.toMatchObject({
      status: "unsafe",
      reason: expect.stringMatching(/no stable process id/i),
    });
    expect(signal).not.toHaveBeenCalled();
  });

  test("rolls back identity capture failure only through the retained handle", async () => {
    const { launchChrome } = await import("../../src/browser/chromeLifecycle.js");
    const { resolveBrowserConfig } = await import("../../src/browser/config.js");
    const profile = profileIdentity("/tmp/oracle-invalid-profile");
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
      message: expect.stringMatching(/capture Chrome process identity/i),
      cause: captureError,
    });
    expect(child.signalCalls).toEqual(["SIGTERM"]);
  });

  test("preserves the unsafe outcome when persistence rollback lacks stable authority", async () => {
    const { createProvisionalIdentityBoundChromeKill } =
      await import("../../src/browser/chromeLifecycle.js");
    const identity = processIdentity(
      "/tmp/oracle-rollback-profile",
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
      createProvisionalIdentityBoundChromeKill(
        identity.profileDirectory.canonicalPath,
        identity,
        stableKill,
        {
          writeIdentity: vi.fn(async () => {
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
    const { createProvisionalIdentityBoundChromeKill } =
      await import("../../src/browser/chromeLifecycle.js");
    const identity = processIdentity(
      "/tmp/oracle-partial-profile",
      9012,
      "55555555-5555-4555-8555-555555555555",
    );
    const writeIdentity = vi.fn(async () => undefined);
    const stableKill = vi.fn(async () => ({
      status: "stopped" as const,
      pid: identity.pid,
      signal: "SIGTERM" as const,
    }));
    const kill = await createProvisionalIdentityBoundChromeKill(
      identity.profileDirectory.canonicalPath,
      identity,
      stableKill,
      { writeIdentity },
    );
    expect(stableKill).not.toHaveBeenCalled();
    await expect(kill()).resolves.toMatchObject({ status: "stopped", pid: identity.pid });
    expect(writeIdentity).toHaveBeenCalledWith(identity.profileDirectory.canonicalPath, identity);
  });
});

describe("registerTerminationHooks", () => {
  test("removes a copied profile only after safe retained-handle termination", async () => {
    const { registerTerminationHooks } = await import("../../src/browser/chromeLifecycle.js");
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "oracle-copy-profile-signal-"));
    await writeFile(path.join(userDataDir, "Cookies"), "sensitive");
    const identity = processIdentity(userDataDir, 1234, "66666666-6666-4666-8666-666666666666");
    const kill = vi.fn(async () => ({
      status: "stopped" as const,
      pid: 1234,
      signal: "SIGTERM" as const,
    }));
    const chrome = chromeLaunchResult(identity, kill);
    const emitRuntimeHint = vi.fn().mockResolvedValue(undefined);
    const handled = deferred<void>();
    const previousExitCode = process.exitCode;
    const removeHooks = registerTerminationHooks(
      chrome,
      userDataDir,
      false,
      vi.fn<(message: string) => void>(),
      {
        isInFlight: () => true,
        emitRuntimeHint,
        forceProfileCleanup: true,
        onSignalHandled: () => handled.resolve(),
      },
    );

    try {
      process.emit("SIGTERM");
      await handled.promise;
      expect(kill).toHaveBeenCalledTimes(1);
      expect(emitRuntimeHint).not.toHaveBeenCalled();
      await expect(stat(userDataDir)).rejects.toThrow();
    } finally {
      removeHooks();
      process.exitCode = previousExitCode;
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("preserves profile and authority after unsafe termination", async () => {
    const { registerTerminationHooks } = await import("../../src/browser/chromeLifecycle.js");
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "oracle-copy-profile-unsafe-"));
    await writeFile(path.join(userDataDir, "authority"), "keep");
    const identity = processIdentity(userDataDir, 1235, "77777777-7777-4777-8777-777777777777");
    const kill = vi.fn(async () => ({
      status: "unsafe" as const,
      pid: 1235,
      reason: "stable handle unavailable",
    }));
    const chrome = chromeLaunchResult(identity, kill);
    const logger = vi.fn<(message: string) => void>();
    const handled = deferred<void>();
    const previousExitCode = process.exitCode;
    const removeHooks = registerTerminationHooks(chrome, userDataDir, false, logger, {
      forceProfileCleanup: true,
      onSignalHandled: () => handled.resolve(),
    });
    try {
      process.emit("SIGTERM");
      await handled.promise;
      expect(existsSync(path.join(userDataDir, "authority"))).toBe(true);
      expect(logger).toHaveBeenCalledWith(expect.stringMatching(/preserving profile/i));
    } finally {
      removeHooks();
      process.exitCode = previousExitCode;
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("clears stale hints with the exact physical profile identity", async () => {
    const { registerTerminationHooks } = await import("../../src/browser/chromeLifecycle.js");
    const profileState = await import("../../src/browser/profileState.js");
    const cleanupMock = vi.mocked(profileState.cleanupStaleProfileState);
    const userDataDir = "/tmp/oracle-manual-login-profile";
    const identity = processIdentity(userDataDir, 1236, "88888888-8888-4888-8888-888888888888");
    const kill = vi.fn(async () => ({
      status: "stopped" as const,
      pid: 1236,
      signal: "SIGTERM" as const,
    }));
    const chrome = chromeLaunchResult(identity, kill);
    const logger = vi.fn<(message: string) => void>();
    const handled = deferred<void>();
    const removeHooks = registerTerminationHooks(chrome, userDataDir, false, logger, {
      preserveUserDataDir: true,
      onSignalHandled: () => handled.resolve(),
    });
    process.emit("SIGINT");
    await handled.promise;
    removeHooks();
    expect(cleanupMock).toHaveBeenCalledWith(userDataDir, logger, {
      lockRemovalMode: "never",
      expectedProfileIdentity: identity.profileDirectory,
    });
  });
});

describe("copied-profile launch flags", () => {
  test("strips mock keychain flags while retaining custom-host launch flags", async () => {
    const { resolveChromeLaunchOptionsForTest } =
      await import("../../src/browser/chromeLifecycle.js");
    const options = resolveChromeLaunchOptionsForTest(
      ["--use-mock-keychain", "--password-store=basic", "--remote-debugging-address=0.0.0.0"],
      true,
    );

    expect(options.ignoreDefaultFlags).toBe(true);
    expect(options.chromeFlags).not.toContain("--use-mock-keychain");
    expect(options.chromeFlags).not.toContain("--password-store=basic");
    expect(options.chromeFlags).toContain("--remote-debugging-address=0.0.0.0");
  });
});

describe("hidden-window launch flags", () => {
  test("keeps macOS Chrome rendered in an off-screen window", async () => {
    const { buildChromeFlagsForTest } = await import("../../src/browser/chromeLifecycle.js");
    const flags = buildChromeFlagsForTest(false, undefined, true);

    if (process.platform === "darwin") {
      expect(flags).toContain("--window-position=-32000,-32000");
    } else {
      expect(flags).not.toContain("--window-position=-32000,-32000");
    }
  });

  test("does not add a window position to headless Chrome", async () => {
    const { buildChromeFlagsForTest } = await import("../../src/browser/chromeLifecycle.js");

    expect(buildChromeFlagsForTest(true, undefined, true)).not.toContain(
      "--window-position=-32000,-32000",
    );
  });

  test("adds no-sandbox flags only when ORACLE_CHROME_NO_SANDBOX=1", async () => {
    const { buildChromeFlagsForTest } = await import("../../src/browser/chromeLifecycle.js");
    const previous = process.env.ORACLE_CHROME_NO_SANDBOX;
    try {
      delete process.env.ORACLE_CHROME_NO_SANDBOX;
      expect(buildChromeFlagsForTest(false)).not.toContain("--no-sandbox");
      process.env.ORACLE_CHROME_NO_SANDBOX = "1";
      const flags = buildChromeFlagsForTest(false);
      expect(flags).toContain("--no-sandbox");
      expect(flags).toContain("--disable-dev-shm-usage");
    } finally {
      if (previous === undefined) {
        delete process.env.ORACLE_CHROME_NO_SANDBOX;
      } else {
        process.env.ORACLE_CHROME_NO_SANDBOX = previous;
      }
    }
  });

  test("moves a running macOS Chrome window without minimizing it", async () => {
    const { positionChromeWindowOffscreen } = await import("../../src/browser/chromeLifecycle.js");
    const browser = {
      getWindowForTarget: vi.fn().mockResolvedValue({ windowId: 7 }),
      setWindowBounds: vi.fn().mockResolvedValue(undefined),
    };
    const logger = vi.fn();

    await positionChromeWindowOffscreen({ Browser: browser } as never, logger as never);

    if (process.platform === "darwin") {
      expect(browser.setWindowBounds).toHaveBeenCalledWith({
        windowId: 7,
        bounds: { left: -32_000, top: -32_000, windowState: "normal" },
      });
    } else {
      expect(browser.setWindowBounds).not.toHaveBeenCalled();
    }
  });
});

describe("connectWithNewTab", () => {
  beforeEach(() => {
    cdpMock.mockReset();
    cdpNewMock.mockReset();
    cdpCloseMock.mockReset();
    cdpListMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("falls back to default target when new tab cannot be opened", async () => {
    cdpNewMock.mockRejectedValue(new Error("boom"));
    cdpMock.mockResolvedValue({});

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBeUndefined();
    expect(cdpNewMock).toHaveBeenCalledTimes(1);
    expect(cdpMock).toHaveBeenCalledWith({ port: 9222, host: "127.0.0.1" });
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("Failed to open isolated browser tab"),
    );
  });

  test("closes unused tab when attach fails", async () => {
    cdpNewMock.mockResolvedValue({ id: "target-1" });
    cdpMock.mockRejectedValueOnce(new Error("attach fail")).mockResolvedValueOnce({});
    cdpCloseMock.mockResolvedValue(undefined);

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBeUndefined();
    expect(cdpNewMock).toHaveBeenCalledTimes(1);
    expect(cdpCloseMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222, id: "target-1" });
    expect(cdpMock).toHaveBeenCalledWith({ port: 9222, host: "127.0.0.1" });
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("Failed to attach to isolated browser tab"),
    );
  });

  test("throws when strict mode disallows fallback", async () => {
    cdpNewMock.mockRejectedValue(new Error("boom"));

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    await expect(
      connectWithNewTab(9222, logger, undefined, undefined, { fallbackToDefault: false }),
    ).rejects.toThrow(/isolated browser tab/i);
    expect(cdpMock).not.toHaveBeenCalled();
  });

  test("returns isolated target when attach succeeds", async () => {
    cdpNewMock.mockResolvedValue({ id: "target-2" });
    cdpMock.mockResolvedValue({});

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBe("target-2");
    expect(cdpNewMock).toHaveBeenCalledTimes(1);
    expect(cdpMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222, target: "target-2" });
  });

  test("retries transient DevTools connection failures before falling back", async () => {
    vi.useFakeTimers();
    cdpNewMock
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:9222"))
      .mockResolvedValueOnce({ id: "target-3" });
    cdpMock.mockResolvedValue({});

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const resultPromise = connectWithNewTab(9222, logger, undefined, undefined, {
      retries: 1,
      retryDelayMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;

    expect(result.targetId).toBe("target-3");
    expect(cdpNewMock).toHaveBeenCalledTimes(2);
    expect(cdpMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222, target: "target-3" });
  });
});

describe("closeBlankChromeTabs", () => {
  beforeEach(() => {
    cdpMock.mockReset();
    cdpNewMock.mockReset();
    cdpCloseMock.mockReset();
    cdpListMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("closes blank tabs while preserving active and conversation targets", async () => {
    cdpListMock.mockResolvedValue([
      { id: "blank-1", type: "page", url: "about:blank" },
      { id: "chat-1", type: "page", url: "https://chatgpt.com/c/abc" },
      { id: "active-blank", type: "page", url: "about:blank" },
      { id: "newtab-1", type: "page", url: "chrome://newtab/" },
      { id: "worker-1", type: "service_worker", url: "about:blank" },
    ]);
    cdpCloseMock.mockResolvedValue(undefined);

    const { closeBlankChromeTabs } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    await closeBlankChromeTabs(9222, logger, "127.0.0.1", {
      excludeTargetIds: ["active-blank"],
    });

    expect(cdpListMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222 });
    expect(cdpCloseMock).toHaveBeenCalledTimes(2);
    expect(cdpCloseMock).toHaveBeenNthCalledWith(1, {
      host: "127.0.0.1",
      port: 9222,
      id: "blank-1",
    });
    expect(cdpCloseMock).toHaveBeenNthCalledWith(2, {
      host: "127.0.0.1",
      port: 9222,
      id: "newtab-1",
    });
    expect(logger).toHaveBeenCalledWith("Closed 2 blank Chrome tabs.");
  });

  test("preserves the same blank target across concurrent cleanup", async () => {
    cdpListMock.mockResolvedValue([
      { id: "blank-a", type: "page", url: "about:blank" },
      { id: "blank-b", type: "page", url: "about:blank" },
    ]);
    cdpCloseMock.mockResolvedValue(undefined);
    const { closeBlankChromeTabs } = await import("../../src/browser/chromeLifecycle.js");

    await Promise.all([
      closeBlankChromeTabs(9222, vi.fn<(message: string) => void>(), "127.0.0.1", {
        excludeTargetIds: ["blank-a"],
        preserveOneBlank: true,
      }),
      closeBlankChromeTabs(9222, vi.fn<(message: string) => void>(), "127.0.0.1", {
        excludeTargetIds: ["blank-b"],
        preserveOneBlank: true,
      }),
    ]);

    expect(cdpCloseMock).toHaveBeenCalledTimes(1);
    expect(cdpCloseMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      id: "blank-b",
    });
  });

  test("collapses concurrent replacements when only the last run cleans up", async () => {
    cdpListMock.mockResolvedValue([
      { id: "blank-a", type: "page", url: "about:blank" },
      { id: "blank-b", type: "page", url: "about:blank" },
    ]);
    cdpCloseMock.mockResolvedValue(undefined);
    const { closeBlankChromeTabs } = await import("../../src/browser/chromeLifecycle.js");

    await closeBlankChromeTabs(9222, vi.fn<(message: string) => void>(), "127.0.0.1", {
      preserveOneBlank: true,
    });

    expect(cdpCloseMock).toHaveBeenCalledTimes(1);
    expect(cdpCloseMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      id: "blank-b",
    });
  });

  test("opens a dedicated tab through a browser websocket endpoint", async () => {
    const send = vi.fn(async () => ({}));
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "target-9" })),
        attachToTarget: vi.fn(async () => ({ sessionId: "session-9" })),
        detachFromTarget: vi.fn(async () => ({})),
        closeTarget: vi.fn(async () => ({ success: true })),
      },
      Network: { enable: vi.fn(async () => ({})) },
      Page: { enable: vi.fn(async () => ({})), navigate: vi.fn(async () => ({})) },
      Runtime: { enable: vi.fn(async () => ({})), evaluate: vi.fn(async () => ({ result: {} })) },
      Input: { dispatchKeyEvent: vi.fn(async () => ({})) },
      DOM: { enable: vi.fn(async () => ({})) },
      Emulation: { setFocusEmulationEnabled: vi.fn(async () => ({})) },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    Object.defineProperty(browserClient, "send", { value: send });
    cdpMock.mockResolvedValue(browserClient);

    const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const connection = await connectToRemoteChrome(
      "127.0.0.1",
      9222,
      logger,
      "https://chatgpt.com/",
      "ws://127.0.0.1:9222/devtools/browser/abc",
    );

    expect(cdpMock).toHaveBeenCalledWith({
      target: "ws://127.0.0.1:9222/devtools/browser/abc",
      local: true,
    });
    expect(browserClient.Target.createTarget).toHaveBeenCalledWith({ url: "https://chatgpt.com/" });
    expect(browserClient.Target.attachToTarget).toHaveBeenCalledWith({
      targetId: "target-9",
      flatten: true,
    });
    expect(connection.targetId).toBe("target-9");
    expect(connection.ownership).toBe("created");
    await connection.client.Emulation.setFocusEmulationEnabled({ enabled: true });
    expect(browserClient.Emulation.setFocusEmulationEnabled).toHaveBeenCalledWith(
      { enabled: true },
      "session-9",
    );
    await (
      connection.client as typeof connection.client & {
        send: (method: string, params: unknown, sessionId: string) => Promise<unknown>;
      }
    ).send("Target.setAutoAttach", { autoAttach: true }, "session-9");
    expect(send).toHaveBeenCalledWith("Target.setAutoAttach", { autoAttach: true }, "session-9");
    await connection.close();
    expect(browserClient.Target.detachFromTarget).toHaveBeenCalledWith({ sessionId: "session-9" });
    expect(browserClient.Target.closeTarget).not.toHaveBeenCalled();
  });

  test("closes a newly created websocket target when attachment fails", async () => {
    const cleanupOrder: string[] = [];
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "created-target" })),
        attachToTarget: vi.fn(async () => {
          throw new Error("attach failed");
        }),
        closeTarget: vi.fn(async () => {
          cleanupOrder.push("target");
          return { success: true };
        }),
      },
      close: vi.fn(async () => {
        cleanupOrder.push("browser");
      }),
    };
    cdpMock.mockResolvedValue(browserClient);

    const { connectToRemoteChromeTarget } = await import("../../src/browser/chromeLifecycle.js");

    await expect(
      connectToRemoteChromeTarget("127.0.0.1", 9222, vi.fn<(message: string) => void>(), {
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        targetUrl: "https://chatgpt.com/",
      }),
    ).rejects.toThrow("attach failed");

    expect(browserClient.Target.closeTarget).toHaveBeenCalledWith({
      targetId: "created-target",
    });
    expect(cleanupOrder).toEqual(["target", "browser"]);
  });

  test("does not close a caller-supplied websocket target when attachment fails", async () => {
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "unused" })),
        attachToTarget: vi.fn(async () => {
          throw new Error("attach failed");
        }),
        closeTarget: vi.fn(async () => ({ success: true })),
      },
      close: vi.fn(async () => undefined),
    };
    cdpMock.mockResolvedValue(browserClient);

    const { connectToRemoteChromeTarget } = await import("../../src/browser/chromeLifecycle.js");

    await expect(
      connectToRemoteChromeTarget("127.0.0.1", 9222, vi.fn<(message: string) => void>(), {
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        targetId: "borrowed-target",
        closeTargetOnDispose: true,
      }),
    ).rejects.toThrow("attach failed");

    expect(browserClient.Target.createTarget).not.toHaveBeenCalled();
    expect(browserClient.Target.closeTarget).not.toHaveBeenCalled();
    expect(browserClient.close).toHaveBeenCalledOnce();
  });

  test("reports explicit attached ownership for the HTTP fallback target", async () => {
    const fallbackClient = { close: vi.fn(async () => undefined) };
    cdpNewMock.mockRejectedValue(new Error("cannot create target"));
    cdpListMock.mockResolvedValue([
      { id: "borrowed-target", type: "page", url: "https://chatgpt.com/" },
    ]);
    cdpMock.mockResolvedValue(fallbackClient);

    const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
    const connection = await connectToRemoteChrome(
      "127.0.0.1",
      9222,
      vi.fn<(message: string) => void>(),
      "about:blank",
    );

    expect(cdpMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      target: "borrowed-target",
    });
    expect(connection.targetId).toBe("borrowed-target");
    expect(connection.ownership).toBe("attached");
  });

  test("waits on a single websocket connection attempt for Chrome approval", async () => {
    vi.useFakeTimers();
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "target-10" })),
        attachToTarget: vi.fn(async () => ({ sessionId: "session-10" })),
        detachFromTarget: vi.fn(async () => ({})),
        closeTarget: vi.fn(async () => ({ success: true })),
      },
      Network: { enable: vi.fn(async () => ({})) },
      Page: { enable: vi.fn(async () => ({})), navigate: vi.fn(async () => ({})) },
      Runtime: { enable: vi.fn(async () => ({})), evaluate: vi.fn(async () => ({ result: {} })) },
      Input: { dispatchKeyEvent: vi.fn(async () => ({})) },
      DOM: { enable: vi.fn(async () => ({})) },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    cdpMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(browserClient), 1_000);
        }),
    );

    const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();
    const promise = connectToRemoteChrome(
      "127.0.0.1",
      9222,
      logger,
      "https://chatgpt.com/",
      "ws://127.0.0.1:9222/devtools/browser/abc",
      { approvalWaitMs: 20_000 },
    );

    await vi.advanceTimersByTimeAsync(1_000);

    const connection = await promise;

    expect(cdpMock).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "Waiting for Chrome remote debugging approval for 127.0.0.1:9222...",
    );
    expect(connection.targetId).toBe("target-10");
  });

  test("fails after the approval wait without opening a second websocket request", async () => {
    vi.useFakeTimers();
    cdpMock.mockImplementationOnce(() => new Promise(() => {}));

    const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();
    const promise = connectToRemoteChrome(
      "127.0.0.1",
      9222,
      logger,
      "https://chatgpt.com/",
      "ws://127.0.0.1:9222/devtools/browser/abc",
      { approvalWaitMs: 20_000 },
    );
    const assertion = expect(promise).rejects.toThrow(
      /waited 20s for Chrome remote debugging approval/i,
    );

    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    expect(cdpMock).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "Waiting for Chrome remote debugging approval for 127.0.0.1:9222...",
    );
  });

  test("retries immediate 403 responses while waiting for remote debugging approval", async () => {
    vi.useFakeTimers();
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "target-20" })),
        attachToTarget: vi.fn(async () => ({ sessionId: "session-20" })),
      },
      close: vi.fn(async () => {}),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
    };
    cdpMock
      .mockRejectedValueOnce(new Error("Unexpected server response: 403"))
      .mockRejectedValueOnce(new Error("Unexpected server response: 403"))
      .mockResolvedValueOnce(browserClient);

    const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();
    const promise = connectToRemoteChrome(
      "127.0.0.1",
      9222,
      logger,
      "https://chatgpt.com/",
      "ws://127.0.0.1:9222/devtools/browser/abc",
      { approvalWaitMs: 20_000 },
    );

    await vi.advanceTimersByTimeAsync(1_000);

    const connection = await promise;

    expect(cdpMock).toHaveBeenCalledTimes(3);
    expect(connection.targetId).toBe("target-20");
  });
});

describe("closeChromeTarget", () => {
  beforeEach(() => {
    cdpMock.mockReset();
    cdpNewMock.mockReset();
    cdpCloseMock.mockReset();
    cdpListMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("retains a replacement page before closing through HTTP", async () => {
    vi.useFakeTimers();
    const cleanupOrder: string[] = [];
    cdpListMock
      .mockResolvedValueOnce([{ id: "owned", type: "page", url: "https://chatgpt.com/c/1" }])
      .mockResolvedValueOnce([{ id: "replacement", type: "page", url: "about:blank" }]);
    cdpNewMock.mockImplementationOnce(async () => {
      cleanupOrder.push("replacement");
      return { id: "replacement" };
    });
    cdpCloseMock.mockImplementationOnce(async () => {
      cleanupOrder.push("close");
    });
    const { closeChromeTarget } = await import("../../src/browser/chromeLifecycle.js");

    const closing = closeChromeTarget({
      port: 9222,
      targetId: "owned",
      logger: vi.fn<(message: string) => void>(),
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(closing).resolves.toBe(true);
    expect(cleanupOrder).toEqual(["replacement", "close"]);
  });

  test("retains a replacement page while closing through a browser websocket", async () => {
    vi.useFakeTimers();
    const browserClient = {
      Target: {
        getTargets: vi
          .fn()
          .mockResolvedValueOnce({
            targetInfos: [{ targetId: "owned", type: "page", url: "https://chatgpt.com/c/1" }],
          })
          .mockResolvedValueOnce({
            targetInfos: [{ targetId: "replacement", type: "page", url: "about:blank" }],
          }),
        createTarget: vi.fn(async () => ({ targetId: "replacement" })),
        closeTarget: vi.fn(async () => ({ success: true })),
      },
      close: vi.fn(async () => undefined),
    };
    cdpMock.mockResolvedValue(browserClient);
    // Load after the hoisted CDP mock so the transport helper uses this test's browser client.
    const { closeChromeTarget } = await import("../../src/browser/chromeLifecycle.js");

    const closing = closeChromeTarget({
      port: 9222,
      targetId: "owned",
      logger: vi.fn<(message: string) => void>(),
      browserWSEndpoint: "wss://remote.example/devtools/browser/abc",
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(closing).resolves.toBe(true);
    expect(browserClient.Target.createTarget).toHaveBeenCalledWith({ url: "about:blank" });
    expect(browserClient.Target.closeTarget).toHaveBeenCalledWith({ targetId: "owned" });
    expect(browserClient.close).toHaveBeenCalledOnce();
  });
});
describe("ensureChromePageTargetAfterClose", () => {
  beforeEach(() => {
    cdpNewMock.mockReset();
    cdpListMock.mockReset();
  });

  test("reuses another page instead of opening a replacement", async () => {
    cdpListMock.mockResolvedValue([
      { id: "run-target", type: "page" },
      { id: "other-target", type: "page" },
    ]);
    const { ensureChromePageTargetAfterClose } =
      await import("../../src/browser/chromeLifecycle.js");

    await expect(
      ensureChromePageTargetAfterClose(
        9222,
        "run-target",
        vi.fn<(message: string) => void>(),
        "127.0.0.1",
      ),
    ).resolves.toBe("other-target");
    expect(cdpNewMock).not.toHaveBeenCalled();
  });

  test("opens a replacement when the completed run owns the only page", async () => {
    cdpListMock.mockResolvedValue([{ id: "run-target", type: "page" }]);
    cdpNewMock.mockResolvedValue({ id: "replacement-target" });
    const { ensureChromePageTargetAfterClose } =
      await import("../../src/browser/chromeLifecycle.js");

    await expect(
      ensureChromePageTargetAfterClose(
        9222,
        "run-target",
        vi.fn<(message: string) => void>(),
        "127.0.0.1",
      ),
    ).resolves.toBe("replacement-target");
    expect(cdpNewMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      url: "about:blank",
    });
  });

  test("reuses a replacement created by an earlier serialized cleanup", async () => {
    cdpListMock.mockResolvedValueOnce([{ id: "run-a", type: "page" }]).mockResolvedValueOnce([
      { id: "run-b", type: "page" },
      { id: "replacement-a", type: "page" },
    ]);
    cdpNewMock.mockResolvedValueOnce({ id: "replacement-a" });
    const { ensureChromePageTargetAfterClose } =
      await import("../../src/browser/chromeLifecycle.js");

    await expect(
      ensureChromePageTargetAfterClose(
        9222,
        "run-a",
        vi.fn<(message: string) => void>(),
        "127.0.0.1",
      ),
    ).resolves.toBe("replacement-a");
    await expect(
      ensureChromePageTargetAfterClose(
        9222,
        "run-b",
        vi.fn<(message: string) => void>(),
        "127.0.0.1",
      ),
    ).resolves.toBe("replacement-a");
    expect(cdpNewMock).toHaveBeenCalledTimes(1);
  });

  test("fails closed when a replacement cannot be opened", async () => {
    cdpListMock.mockResolvedValue([{ id: "run-target", type: "page" }]);
    cdpNewMock.mockRejectedValue(new Error("cannot create"));
    const { ensureChromePageTargetAfterClose } =
      await import("../../src/browser/chromeLifecycle.js");

    await expect(
      ensureChromePageTargetAfterClose(
        9222,
        "run-target",
        vi.fn<(message: string) => void>(),
        "127.0.0.1",
      ),
    ).resolves.toBeUndefined();
  });
});

describe("closeTab", () => {
  beforeEach(() => {
    cdpCloseMock.mockReset();
    cdpListMock.mockReset();
  });

  test("waits for the closed target to disappear", async () => {
    cdpCloseMock.mockResolvedValue(undefined);
    cdpListMock
      .mockResolvedValueOnce([{ id: "closing-target", type: "page" }])
      .mockResolvedValueOnce([{ id: "retained-target", type: "page" }]);
    const { closeTab } = await import("../../src/browser/chromeLifecycle.js");

    await expect(
      closeTab(9222, "closing-target", vi.fn<(message: string) => void>(), "127.0.0.1"),
    ).resolves.toBe(true);

    expect(cdpCloseMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      id: "closing-target",
    });
    expect(cdpListMock).toHaveBeenCalledTimes(2);
  });

  test("reports an unconfirmed close when the target never disappears", async () => {
    vi.useFakeTimers();
    try {
      cdpCloseMock.mockResolvedValue(undefined);
      cdpListMock.mockResolvedValue([{ id: "closing-target", type: "page" }]);
      const { closeTab } = await import("../../src/browser/chromeLifecycle.js");

      const closePromise = closeTab(
        9222,
        "closing-target",
        vi.fn<(message: string) => void>(),
        "127.0.0.1",
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(closePromise).resolves.toBe(false);
      expect(cdpListMock).toHaveBeenCalledTimes(40);
    } finally {
      vi.useRealTimers();
    }
  });
});
