import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LaunchedChrome } from "chrome-launcher";

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

vi.mock("chrome-remote-interface", () => ({ default: cdpMock }));

vi.doMock("../../src/browser/profileState.js", async () => {
  const original = await vi.importActual<typeof import("../../src/browser/profileState.js")>(
    "../../src/browser/profileState.js",
  );
  return {
    ...original,
    cleanupStaleProfileState: vi.fn(async () => undefined),
  };
});

describe("hidden macOS Chrome launch", () => {
  test("uses a background-hidden app launch instead of the standard launcher", async () => {
    const { launchChrome } = await import("../../src/browser/chromeLifecycle.js");
    const { resolveBrowserConfig } = await import("../../src/browser/config.js");
    const hiddenMacLaunch = vi.fn(
      async () =>
        ({
          pid: 4321,
          port: 9222,
          process: undefined,
          remoteDebuggingPipes: null,
          kill: vi.fn(),
        }) as unknown as LaunchedChrome & { host?: string },
    );
    const standardLaunch = vi.fn();
    const logger = vi.fn<(message: string) => void>();

    await launchChrome(
      resolveBrowserConfig({ hideWindow: false, debugPort: 9222 }),
      "/tmp/oracle-hidden-profile",
      logger,
      { platform: "darwin", hiddenMacLaunch, standardLaunch },
    );

    expect(hiddenMacLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ userDataDir: "/tmp/oracle-hidden-profile", requestedPort: 9222 }),
    );
    expect(standardLaunch).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("hidden background Chrome"));
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

    await expect(
      launchChrome(
        resolveBrowserConfig({ hideWindow: true }),
        "/tmp/oracle-hidden-profile",
        vi.fn<(message: string) => void>(),
        { platform: "linux" },
      ),
    ).rejects.toThrow(/use --remote-chrome/i);
  });
});

describe("registerTerminationHooks", () => {
  test("kills Chrome and removes a copied profile on an in-flight signal", async () => {
    const { registerTerminationHooks } = await import("../../src/browser/chromeLifecycle.js");
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "oracle-copy-profile-signal-"));
    await writeFile(path.join(userDataDir, "Cookies"), "sensitive");
    const chrome = {
      kill: vi.fn().mockResolvedValue(undefined),
      pid: 1234,
      port: 9222,
    };
    const emitRuntimeHint = vi.fn().mockResolvedValue(undefined);
    const previousExitCode = process.exitCode;
    const removeHooks = registerTerminationHooks(
      chrome as unknown as import("chrome-launcher").LaunchedChrome,
      userDataDir,
      false,
      vi.fn() as unknown as import("../../src/browser/types.js").BrowserLogger,
      {
        isInFlight: () => true,
        emitRuntimeHint,
        forceProfileCleanup: true,
      },
    );

    try {
      process.emit("SIGTERM");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (
          await stat(userDataDir)
            .then(() => false)
            .catch(() => true)
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(chrome.kill).toHaveBeenCalledTimes(1);
      expect(emitRuntimeHint).not.toHaveBeenCalled();
      await expect(stat(userDataDir)).rejects.toThrow();
    } finally {
      removeHooks();
      process.exitCode = previousExitCode;
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("clears stale DevToolsActivePort hints when preserving userDataDir", async () => {
    const { registerTerminationHooks } = await import("../../src/browser/chromeLifecycle.js");
    const profileState = await import("../../src/browser/profileState.js");
    const cleanupMock = vi.mocked(profileState.cleanupStaleProfileState);

    const chrome = {
      kill: vi.fn().mockResolvedValue(undefined),
      pid: 1234,
      port: 9222,
    };
    const logger = vi.fn();
    const userDataDir = "/tmp/oracle-manual-login-profile";

    const removeHooks = registerTerminationHooks(
      chrome as unknown as LaunchedChrome,
      userDataDir,
      false,
      logger,
      {
        isInFlight: () => false,
        preserveUserDataDir: true,
      },
    );

    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 10));

    removeHooks();

    expect(chrome.kill).toHaveBeenCalledTimes(1);
    expect(cleanupMock).toHaveBeenCalledWith(userDataDir, logger, { lockRemovalMode: "never" });
  });
  test("bounds a stalled runtime hint before completing signal shutdown", async () => {
    const { registerTerminationHooks } = await import("../../src/browser/chromeLifecycle.js");
    vi.useFakeTimers();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const chrome = {
      kill: vi.fn().mockResolvedValue(undefined),
      pid: 1234,
      port: 9222,
    };
    const emitRuntimeHint = vi.fn(() => new Promise<void>(() => undefined));
    const removeHooks = registerTerminationHooks(
      chrome as unknown as LaunchedChrome,
      "/tmp/oracle-stalled-runtime-hint-profile",
      true,
      vi.fn<(message: string) => void>(),
      {
        isInFlight: () => true,
        emitRuntimeHint,
      },
    );

    try {
      process.emit("SIGTERM");
      process.emit("SIGINT");
      expect(emitRuntimeHint).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();

      await vi.advanceTimersByTimeAsync(249);
      expect(process.exitCode).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(process.exitCode).toBe(1);

      process.emit("SIGQUIT");
      await vi.advanceTimersByTimeAsync(250);
      expect(emitRuntimeHint).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    } finally {
      removeHooks();
      process.exitCode = previousExitCode;
      vi.useRealTimers();
    }
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

  test("closes a browser websocket client that resolves after approval timeout", async () => {
    vi.useFakeTimers();
    const lateClient = { close: vi.fn(async () => {}) };
    let resolveClient!: (client: typeof lateClient) => void;
    cdpMock.mockImplementationOnce(
      () =>
        new Promise<typeof lateClient>((resolve) => {
          resolveClient = resolve;
        }),
    );

    try {
      const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
      const pending = connectToRemoteChrome(
        "127.0.0.1",
        9222,
        vi.fn<(message: string) => void>(),
        "https://chatgpt.com/",
        "ws://127.0.0.1:9222/devtools/browser/abc",
        { approvalWaitMs: 20 },
      );
      const outcome = pending.then(
        () => new Error("Expected remote debugging approval to time out."),
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(20);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/waited 20ms for Chrome remote debugging approval/i);

      resolveClient(lateClient);
      await Promise.resolve();
      expect(lateClient.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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

describe("connectToRemoteChromeTarget", () => {
  beforeEach(() => {
    cdpMock.mockReset();
  });

  test("rejects a browser WebSocket outside the configured authority before CDP", async () => {
    // The profileState doMock above must be registered before this module is loaded.
    const { connectToRemoteChromeTarget } = await import("../../src/browser/chromeLifecycle.js");

    await expect(
      connectToRemoteChromeTarget("127.0.0.1", 9222, vi.fn<(message: string) => void>(), {
        browserWSEndpoint: "ws://attacker.invalid:9222/devtools/browser/abc",
        targetUrl: "https://chatgpt.com/",
        closeTargetOnDispose: true,
      }),
    ).rejects.toThrow(/authority/i);
    expect(cdpMock).not.toHaveBeenCalled();
  });

  test("closes and confirms a newly created target when attach fails without disposal cleanup", async () => {
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "target-attach-failure" })),
        attachToTarget: vi.fn(async () => {
          throw new Error("attach failed");
        }),
        closeTarget: vi.fn(async () => ({ success: true })),
        getTargets: vi.fn(async () => ({ targetInfos: [] })),
      },
      close: vi.fn(async () => {}),
    };
    cdpMock.mockResolvedValue(browserClient);
    const { connectToRemoteChromeTarget } = await import("../../src/browser/chromeLifecycle.js");

    await expect(
      connectToRemoteChromeTarget("127.0.0.1", 9222, vi.fn<(message: string) => void>(), {
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        targetUrl: "https://chatgpt.com/",
        closeTargetOnDispose: false,
      }),
    ).rejects.toThrow(/attach failed/);

    expect(browserClient.Target.closeTarget).toHaveBeenCalledWith({
      targetId: "target-attach-failure",
    });
    expect(browserClient.Target.getTargets).toHaveBeenCalledOnce();
    expect(browserClient.close).toHaveBeenCalledOnce();
  });

  test("bounds target attachment and cleans up a target created before timeout", async () => {
    vi.useFakeTimers();
    let resolveAttach!: (result: { sessionId: string }) => void;
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "target-attach-timeout" })),
        attachToTarget: vi.fn(
          () =>
            new Promise<{ sessionId: string }>((resolve) => {
              resolveAttach = resolve;
            }),
        ),
        detachFromTarget: vi.fn(async () => ({})),
        closeTarget: vi.fn(async () => ({ success: true })),
        getTargets: vi.fn(async () => ({ targetInfos: [] })),
      },
      close: vi.fn(async () => {}),
    };
    cdpMock.mockResolvedValue(browserClient);

    try {
      const { connectToRemoteChromeTarget } = await import("../../src/browser/chromeLifecycle.js");
      const pending = connectToRemoteChromeTarget(
        "127.0.0.1",
        9222,
        vi.fn<(message: string) => void>(),
        {
          browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
          targetUrl: "https://chatgpt.com/",
          closeTargetOnDispose: false,
        },
      );
      const outcome = pending.then(
        () => new Error("Expected remote target attachment to time out."),
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(50);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out attaching to remote Chrome target/i);
      expect(browserClient.Target.closeTarget).toHaveBeenCalledWith({
        targetId: "target-attach-timeout",
      });
      expect(browserClient.close).toHaveBeenCalledOnce();

      resolveAttach({ sessionId: "late-session" });
      await Promise.resolve();
      expect(browserClient.Target.detachFromTarget).toHaveBeenCalledWith({
        sessionId: "late-session",
      });
    } finally {
      vi.useRealTimers();
    }
  });
  test("polls until a stale remote target snapshot clears after close", async () => {
    vi.useFakeTimers();
    try {
      const browserClient = {
        Target: {
          createTarget: vi.fn(async () => ({ targetId: "target-poll" })),
          attachToTarget: vi.fn(async () => ({ sessionId: "session-poll" })),
          detachFromTarget: vi.fn(async () => ({})),
          closeTarget: vi.fn(async () => ({ success: true })),
          getTargets: vi
            .fn()
            .mockResolvedValueOnce({
              targetInfos: [{ targetId: "target-poll", type: "page", url: "https://chatgpt.com/" }],
            })
            .mockResolvedValueOnce({ targetInfos: [] }),
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
      cdpMock.mockResolvedValue(browserClient);
      const { connectToRemoteChromeTarget } = await import("../../src/browser/chromeLifecycle.js");
      const connection = await connectToRemoteChromeTarget(
        "127.0.0.1",
        9222,
        vi.fn<(message: string) => void>(),
        {
          browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
          targetUrl: "https://chatgpt.com/",
          closeTargetOnDispose: true,
        },
      );

      const closing = connection.close();
      await vi.advanceTimersByTimeAsync(50);

      await expect(closing).resolves.toBeUndefined();
      expect(browserClient.Target.getTargets).toHaveBeenCalledTimes(2);
      expect(browserClient.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("accepts a targetDestroyed event during remote target cleanup", async () => {
    vi.useFakeTimers();
    try {
      let targetDestroyed: ((event: { targetId?: string }) => void) | undefined;
      const browserClient = {
        Target: {
          createTarget: vi.fn(async () => ({ targetId: "target-destroyed" })),
          attachToTarget: vi.fn(async () => ({ sessionId: "session-destroyed" })),
          detachFromTarget: vi.fn(async () => ({})),
          closeTarget: vi.fn(async () => {
            targetDestroyed?.({ targetId: "target-destroyed" });
            return { success: true };
          }),
          getTargets: vi.fn(async () => ({
            targetInfos: [
              { targetId: "target-destroyed", type: "page", url: "https://chatgpt.com/" },
            ],
          })),
        },
        Network: { enable: vi.fn(async () => ({})) },
        Page: { enable: vi.fn(async () => ({})), navigate: vi.fn(async () => ({})) },
        Runtime: { enable: vi.fn(async () => ({})), evaluate: vi.fn(async () => ({ result: {} })) },
        Input: { dispatchKeyEvent: vi.fn(async () => ({})) },
        DOM: { enable: vi.fn(async () => ({})) },
        on: vi.fn((event: string, listener: (event: { targetId?: string }) => void) => {
          if (event === "Target.targetDestroyed") targetDestroyed = listener;
        }),
        once: vi.fn(),
        removeListener: vi.fn(),
        close: vi.fn(async () => {}),
      };
      cdpMock.mockResolvedValue(browserClient);
      const { connectToRemoteChromeTarget } = await import("../../src/browser/chromeLifecycle.js");
      const connection = await connectToRemoteChromeTarget(
        "127.0.0.1",
        9222,
        vi.fn<(message: string) => void>(),
        {
          browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
          targetUrl: "https://chatgpt.com/",
          closeTargetOnDispose: true,
        },
      );

      const closing = connection.close();
      await vi.advanceTimersByTimeAsync(25);

      await expect(closing).resolves.toBeUndefined();
      expect(browserClient.Target.getTargets).not.toHaveBeenCalled();
      expect(browserClient.removeListener).toHaveBeenCalledWith(
        "Target.targetDestroyed",
        expect.any(Function),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("surfaces dedicated remote-target disposal failures", async () => {
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "target-cleanup" })),
        attachToTarget: vi.fn(async () => ({ sessionId: "session-cleanup" })),
        detachFromTarget: vi.fn(async () => ({})),
        closeTarget: vi.fn(async () => {
          throw new Error("target close failed");
        }),
        getTargets: vi.fn(async () => ({
          targetInfos: [{ targetId: "target-cleanup", type: "page", url: "https://chatgpt.com/" }],
        })),
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
    cdpMock.mockResolvedValue(browserClient);
    const logger = vi.fn<(message: string) => void>();
    const { connectToRemoteChromeTarget } = await import("../../src/browser/chromeLifecycle.js");

    const connection = await connectToRemoteChromeTarget("127.0.0.1", 9222, logger, {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      targetUrl: "https://chatgpt.com/",
      closeTargetOnDispose: true,
    });

    await expect(connection.close()).rejects.toThrow(/remote Chrome target cleanup failed/i);
    expect(browserClient.Target.closeTarget).toHaveBeenCalledWith({ targetId: "target-cleanup" });
    expect(browserClient.close).toHaveBeenCalledOnce();
  });

  test("bounds non-dedicated remote connection cleanup", async () => {
    vi.useRealTimers();
    const browserClient = {
      Target: {
        attachToTarget: vi.fn(async () => ({ sessionId: "existing-session" })),
        detachFromTarget: vi.fn(() => new Promise<never>(() => undefined)),
      },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(() => new Promise<never>(() => undefined)),
    };
    cdpMock.mockResolvedValue(browserClient);

    const { connectToRemoteChromeTarget } = await import("../../src/browser/chromeLifecycle.js");
    const connection = await connectToRemoteChromeTarget(
      "127.0.0.1",
      9222,
      vi.fn<(message: string) => void>(),
      {
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        targetId: "existing-target",
        closeTargetOnDispose: false,
      },
    );
    const error = await connection.close().then(
      () => new Error("Expected remote connection cleanup to time out."),
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/remote Chrome connection cleanup failed/i);
    expect(browserClient.Target.detachFromTarget).toHaveBeenCalledWith({
      sessionId: "existing-session",
    });
    expect(browserClient.close).toHaveBeenCalledOnce();
  }, 2_000);
  test("bounds hung CDP commands while destroying a dedicated remote target", async () => {
    vi.useFakeTimers();
    try {
      const browserClient = {
        Target: {
          createTarget: vi.fn(async () => ({ targetId: "target-hung-cleanup" })),
          attachToTarget: vi.fn(async () => ({ sessionId: "session-hung-cleanup" })),
          detachFromTarget: vi.fn(async () => ({})),
          closeTarget: vi.fn(() => new Promise<never>(() => undefined)),
          getTargets: vi.fn(() => new Promise<never>(() => undefined)),
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
      cdpMock.mockResolvedValue(browserClient);
      const { connectToRemoteChromeTarget } = await import("../../src/browser/chromeLifecycle.js");
      const connection = await connectToRemoteChromeTarget(
        "127.0.0.1",
        9222,
        vi.fn<(message: string) => void>(),
        {
          browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
          targetUrl: "https://chatgpt.com/",
          closeTargetOnDispose: true,
        },
      );
      const closing = connection.close().then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(1_500);

      const error = await closing;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/remote Chrome target cleanup failed/i);

      expect(browserClient.Target.closeTarget).toHaveBeenCalledOnce();
      expect(browserClient.Target.getTargets).toHaveBeenCalled();
      expect(browserClient.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("accepts target-scoped disposal errors once target absence is confirmed", async () => {
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "target-absent" })),
        attachToTarget: vi.fn(async () => ({ sessionId: "session-absent" })),
        detachFromTarget: vi.fn(async () => {
          throw new Error("session already detached");
        }),
        closeTarget: vi.fn(async () => {
          throw new Error("target already closed");
        }),
        getTargets: vi.fn(async () => ({ targetInfos: [] })),
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
    cdpMock.mockResolvedValue(browserClient);
    const { connectToRemoteChromeTarget } = await import("../../src/browser/chromeLifecycle.js");
    const connection = await connectToRemoteChromeTarget(
      "127.0.0.1",
      9222,
      vi.fn<(message: string) => void>(),
      {
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        targetUrl: "https://chatgpt.com/",
        closeTargetOnDispose: true,
      },
    );

    await expect(connection.close()).resolves.toBeUndefined();
    expect(browserClient.Target.getTargets).toHaveBeenCalledOnce();
    expect(browserClient.close).toHaveBeenCalledOnce();
  });

  test("preserves browser-close failures after target absence is confirmed", async () => {
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "target-browser-close" })),
        attachToTarget: vi.fn(async () => ({ sessionId: "session-browser-close" })),
        detachFromTarget: vi.fn(async () => {
          throw new Error("session already detached");
        }),
        closeTarget: vi.fn(async () => {
          throw new Error("target already closed");
        }),
        getTargets: vi.fn(async () => ({ targetInfos: [] })),
      },
      Network: { enable: vi.fn(async () => ({})) },
      Page: { enable: vi.fn(async () => ({})), navigate: vi.fn(async () => ({})) },
      Runtime: { enable: vi.fn(async () => ({})), evaluate: vi.fn(async () => ({ result: {} })) },
      Input: { dispatchKeyEvent: vi.fn(async () => ({})) },
      DOM: { enable: vi.fn(async () => ({})) },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(async () => {
        throw new Error("browser close failed");
      }),
    };
    cdpMock.mockResolvedValue(browserClient);
    const { connectToRemoteChromeTarget } = await import("../../src/browser/chromeLifecycle.js");
    const connection = await connectToRemoteChromeTarget(
      "127.0.0.1",
      9222,
      vi.fn<(message: string) => void>(),
      {
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        targetUrl: "https://chatgpt.com/",
        closeTargetOnDispose: true,
      },
    );

    await expect(connection.close()).rejects.toThrow(/browser close failed/i);
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

  test("treats an already-closed target as successful cleanup", async () => {
    cdpCloseMock.mockRejectedValue(new Error("target already closed"));
    cdpListMock.mockResolvedValue([{ id: "retained-target", type: "page" }]);
    // Dynamic import keeps the CDP/profileState mocks registered before module initialization.
    const { closeTab } = await import("../../src/browser/chromeLifecycle.js");

    await expect(
      closeTab(9222, "closed-target", vi.fn<(message: string) => void>(), "127.0.0.1"),
    ).resolves.toBe(true);
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
