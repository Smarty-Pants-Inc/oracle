import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const cdpNewMock = vi.fn();
const cdpCloseMock = vi.fn();
const cdpListMock = vi.fn();
const launchMock = vi.fn();
const launchCarbonylMock = vi.fn();
const cdpMock = Object.assign(vi.fn(), {
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  New: cdpNewMock,
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  Close: cdpCloseMock,
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  List: cdpListMock,
});

vi.mock("chrome-remote-interface", () => ({ default: cdpMock }));
vi.mock("chrome-launcher", () => ({
  launch: launchMock,
  Launcher: class MockLauncher {
    static defaultFlags() {
      return ["--default-flag"];
    }

    static getFirstInstallation() {
      return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    }
  },
}));
vi.mock("../../src/browser/carbonylLifecycle.js", () => ({
  launchCarbonyl: launchCarbonylMock,
}));

vi.doMock("../../src/browser/profileState.js", async () => {
  const original = await vi.importActual<typeof import("../../src/browser/profileState.js")>(
    "../../src/browser/profileState.js",
  );
  return {
    ...original,
    cleanupStaleProfileState: vi.fn(async () => undefined),
  };
});

describe("launchChrome", () => {
  test("delegates carbonyl launches to the PTY-backed launcher", async () => {
    launchCarbonylMock.mockResolvedValue({
      pid: 4321,
      port: 9444,
      kill: vi.fn(async () => undefined),
      process: {},
      host: "127.0.0.1",
    });
    const { launchChrome } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await launchChrome(
      {
        launcher: "carbonyl",
        chromePath: null,
        debugPort: 9444,
        headless: false,
        url: "https://chatgpt.com/",
      } as never,
      "/tmp/oracle-carbonyl-profile",
      logger,
    );

    expect(launchCarbonylMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chromePath: null,
        debugPort: 9444,
        url: "about:blank",
        userDataDir: "/tmp/oracle-carbonyl-profile",
      }),
      logger,
    );
    expect(launchMock).not.toHaveBeenCalled();
    expect(result.port).toBe(9444);
  });

  test("uses a detached direct Chrome launch when hide-window mode is enabled", async () => {
    vi.resetModules();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });

    const execFileMock = vi.fn(
      (
        file: string,
        args: string[],
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        if (file === "lsof") {
          callback(null, "4242\n", "");
          return;
        }
        if (file === "ps") {
          callback(
            null,
            "4242 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9333 --user-data-dir=/tmp/oracle-hidden-profile\n",
            "",
          );
          return;
        }
        callback(new Error(`unexpected execFile: ${file}`));
      },
    );
    Reflect.set(
      execFileMock as object,
      promisify.custom,
      (file: string, args: string[]) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFileMock(file, args, (error, stdout = "", stderr = "") => {
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        }),
    );

    const createConnectionMock = vi.fn(() => {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const socket = {
        once(event: string, listener: (...args: unknown[]) => void) {
          listeners.set(event, listener);
          if (event === "connect") {
            queueMicrotask(() => listener());
          }
          return socket;
        },
        removeAllListeners() {
          listeners.clear();
          return socket;
        },
        end() {
          return socket;
        },
        destroy() {
          return socket;
        },
        unref() {
          return socket;
        },
      };
      return socket;
    });
    const createServerMock = vi.fn(() => {
      const server = {
        unref() {
          return server;
        },
        once(_event: string, _listener: (...args: unknown[]) => void) {
          return server;
        },
        listen(_port: number, _host: string, listener: () => void) {
          queueMicrotask(listener);
          return server;
        },
        address() {
          return { port: 9333 };
        },
        close(callback?: (error?: Error) => void) {
          callback?.();
          return server;
        },
      };
      return server;
    });
    const spawnMock = vi.fn(() => ({
      pid: 4242,
      unref: vi.fn(),
    }));

    vi.doMock("node:child_process", () => ({
      execFile: execFileMock,
      spawn: spawnMock,
    }));
    vi.doMock("node:net", () => ({
      default: {
        createConnection: createConnectionMock,
        createServer: createServerMock,
      },
    }));

    try {
      const { launchChrome } = await import("../../src/browser/chromeLifecycle.js");
      const logger = vi.fn();

      const result = await launchChrome(
        {
          launcher: "chrome",
          chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          debugPort: 9333,
          headless: false,
          hideWindow: true,
          url: "https://chatgpt.com/",
        } as never,
        "/tmp/oracle-hidden-profile",
        logger,
      );

      expect(launchMock).not.toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalledWith(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        expect.arrayContaining([
          "--default-flag",
          "--remote-debugging-port=9333",
          "--user-data-dir=/tmp/oracle-hidden-profile",
          "--no-startup-window",
        ]),
        expect.objectContaining({
          detached: true,
          stdio: ["ignore", expect.any(Number), expect.any(Number)],
        }),
      );
      expect(createConnectionMock).toHaveBeenCalledWith({
        host: "127.0.0.1",
        port: 9333,
      });
      expect(result.pid).toBe(4242);
      expect(result.port).toBe(9333);
      expect(logger).toHaveBeenCalledWith("Launched Chrome (pid 4242) on port 9333");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      vi.resetModules();
      vi.doUnmock("node:child_process");
      vi.doUnmock("node:net");
    }
  });

  test("forces a detached direct hidden Chrome launch even when hide-window was omitted", async () => {
    vi.resetModules();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });

    const execFileMock = vi.fn(
      (
        file: string,
        args: string[],
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        if (file === "lsof") {
          callback(null, "5252\n", "");
          return;
        }
        if (file === "ps") {
          callback(
            null,
            "5252 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9444 --user-data-dir=/tmp/oracle-forced-hidden-profile\n",
            "",
          );
          return;
        }
        callback(new Error(`unexpected execFile: ${file}`));
      },
    );
    Reflect.set(
      execFileMock as object,
      promisify.custom,
      (file: string, args: string[]) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFileMock(file, args, (error, stdout = "", stderr = "") => {
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        }),
    );

    const createConnectionMock = vi.fn(() => {
      const socket = {
        once(event: string, listener: (...args: unknown[]) => void) {
          if (event === "connect") {
            queueMicrotask(() => listener());
          }
          return socket;
        },
        removeAllListeners() {
          return socket;
        },
        end() {
          return socket;
        },
        destroy() {
          return socket;
        },
        unref() {
          return socket;
        },
      };
      return socket;
    });
    const createServerMock = vi.fn(() => {
      const server = {
        unref() {
          return server;
        },
        once(_event: string, _listener: (...args: unknown[]) => void) {
          return server;
        },
        listen(_port: number, _host: string, listener: () => void) {
          queueMicrotask(listener);
          return server;
        },
        address() {
          return { port: 9444 };
        },
        close(callback?: (error?: Error) => void) {
          callback?.();
          return server;
        },
      };
      return server;
    });
    const spawnMock = vi.fn(() => ({
      pid: 5252,
      unref: vi.fn(),
    }));

    vi.doMock("node:child_process", () => ({
      execFile: execFileMock,
      spawn: spawnMock,
    }));
    vi.doMock("node:net", () => ({
      default: {
        createConnection: createConnectionMock,
        createServer: createServerMock,
      },
    }));

    try {
      const { launchChrome } = await import("../../src/browser/chromeLifecycle.js");
      const logger = vi.fn();

      const result = await launchChrome(
        {
          launcher: "chrome",
          chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          debugPort: 9444,
          headless: false,
          hideWindow: false,
          url: "https://chatgpt.com/",
        } as never,
        "/tmp/oracle-forced-hidden-profile",
        logger,
      );

      expect(launchMock).not.toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalledWith(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        expect.arrayContaining([
          "--default-flag",
          "--remote-debugging-port=9444",
          "--user-data-dir=/tmp/oracle-forced-hidden-profile",
          "--no-startup-window",
        ]),
        expect.objectContaining({
          detached: true,
          stdio: ["ignore", expect.any(Number), expect.any(Number)],
        }),
      );
      expect(createConnectionMock).toHaveBeenCalledWith({
        host: "127.0.0.1",
        port: 9444,
      });
      expect(result.pid).toBe(5252);
      expect(result.port).toBe(9444);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      vi.resetModules();
      vi.doUnmock("node:child_process");
      vi.doUnmock("node:net");
    }
  });
});

describe("registerTerminationHooks", () => {
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
      chrome as unknown as import("chrome-launcher").LaunchedChrome,
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
    vi.unstubAllGlobals();
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

  test("can attach directly to the default target without opening a new tab", async () => {
    const browserClient = {
      Target: {
        getTargets: vi.fn(async () => ({
          targetInfos: [{ targetId: "target-page", type: "page", url: "https://chatgpt.com/" }],
        })),
        attachToTarget: vi.fn(async () => ({ sessionId: "session-1" })),
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
    cdpMock.mockResolvedValue(browserClient);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/browser-1",
        }),
      })),
    );

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger, undefined, undefined, {
      preferDefaultTarget: true,
    });

    expect(result.targetId).toBe("target-page");
    expect(cdpNewMock).not.toHaveBeenCalled();
    expect(cdpMock).toHaveBeenCalledWith({
      target: "ws://127.0.0.1:9222/devtools/browser/browser-1",
      local: true,
    });
    expect(logger).toHaveBeenCalledWith(
      "Skipping isolated browser tab creation; attaching to the default target.",
    );
  });

  test("opens a dedicated tab through a browser websocket endpoint", async () => {
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "target-9" })),
        getTargetInfo: vi.fn(async () => ({
          targetInfo: { targetId: "target-9", type: "page", url: "https://chatgpt.com/" },
        })),
        attachToTarget: vi.fn(async () => ({ sessionId: "session-9" })),
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
  });

  test("fails fast when a browser websocket target id is stale", async () => {
    const browserClient = {
      Target: {
        getTargetInfo: vi.fn(async () => {
          throw new Error("No target with given id found");
        }),
        attachToTarget: vi.fn(async () => ({ sessionId: "session-stale" })),
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
    cdpMock.mockResolvedValue(browserClient);

    const { connectToRemoteChromeTarget } = await import("../../src/browser/chromeLifecycle.js");

    await expect(
      connectToRemoteChromeTarget("127.0.0.1", 9222, vi.fn() as never, {
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        targetId: "stale-target",
      }),
    ).rejects.toThrow("Remote Chrome target stale-target is unavailable");
    expect(browserClient.Target.attachToTarget).not.toHaveBeenCalled();
    expect(browserClient.close).toHaveBeenCalledTimes(1);
  });

  test("preserves a reusable browser websocket tab when closeTargetOnDispose is false", async () => {
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "target-keep" })),
        attachToTarget: vi.fn(async () => ({ sessionId: "session-keep" })),
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
    cdpMock.mockResolvedValue(browserClient);

    const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const connection = await connectToRemoteChrome(
      "127.0.0.1",
      9222,
      logger,
      "https://chatgpt.com/",
      "ws://127.0.0.1:9222/devtools/browser/abc",
      { closeTargetOnDispose: false },
    );

    await connection.close();

    expect(connection.targetId).toBe("target-keep");
    expect(browserClient.Target.detachFromTarget).toHaveBeenCalledWith({
      sessionId: "session-keep",
    });
    expect(browserClient.Target.closeTarget).not.toHaveBeenCalled();
  });

  test("opens a hidden browser target when requested", async () => {
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "target-hidden" })),
        attachToTarget: vi.fn(async () => ({ sessionId: "session-hidden" })),
        detachFromTarget: vi.fn(async () => ({})),
        closeTarget: vi.fn(async () => ({ success: true })),
      },
      Network: { enable: vi.fn(async () => ({})) },
      Page: { enable: vi.fn(async () => ({})), navigate: vi.fn(async () => ({})) },
      Runtime: {
        enable: vi.fn(async () => ({ result: {} })),
        evaluate: vi.fn(async () => ({ result: {} })),
      },
      Input: { dispatchKeyEvent: vi.fn(async () => ({})) },
      DOM: { enable: vi.fn(async () => ({})) },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    cdpMock.mockResolvedValue(browserClient);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/browser-hidden",
        }),
      })),
    );

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger, "about:blank", undefined, {
      hiddenTarget: true,
      fallbackToDefault: false,
    });

    expect(result.targetId).toBe("target-hidden");
    expect(result.browserWSEndpoint).toBe("ws://127.0.0.1:9222/devtools/browser/browser-hidden");
    expect(browserClient.Target.createTarget).toHaveBeenCalledWith({
      url: "about:blank",
      background: true,
      hidden: true,
      focus: false,
    });
    expect(logger).toHaveBeenCalledWith(
      "Opening hidden browser target via browser websocket endpoint.",
    );
  });

  test("preserves an isolated local tab when closeTargetOnDispose is false", async () => {
    cdpNewMock.mockClear();
    cdpCloseMock.mockClear();
    cdpNewMock.mockResolvedValue({ id: "target-local-keep" });
    const baseClose = vi.fn(async () => {});
    const client = {
      close: baseClose,
    };
    cdpMock.mockResolvedValue(client);

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger, "about:blank", undefined, {
      closeTargetOnDispose: false,
    });

    await result.client.close();

    expect(cdpNewMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      url: "about:blank",
    });
    expect(baseClose).toHaveBeenCalledTimes(1);
    expect(cdpCloseMock).not.toHaveBeenCalled();
  });

  test("falls back to a dedicated background target when hidden targets are unsupported", async () => {
    const browserClient = {
      Target: {
        createTarget: vi
          .fn()
          .mockRejectedValueOnce(
            new Error("Hidden target can be created only when remote debugging is enabled"),
          )
          .mockResolvedValueOnce({ targetId: "target-background-fallback" }),
        attachToTarget: vi.fn(async () => ({ sessionId: "session-background-fallback" })),
        detachFromTarget: vi.fn(async () => ({})),
        closeTarget: vi.fn(async () => ({ success: true })),
      },
      Network: { enable: vi.fn(async () => ({})) },
      Page: { enable: vi.fn(async () => ({})), navigate: vi.fn(async () => ({})) },
      Runtime: {
        enable: vi.fn(async () => ({ result: {} })),
        evaluate: vi.fn(async () => ({ result: {} })),
      },
      Input: { dispatchKeyEvent: vi.fn(async () => ({})) },
      DOM: { enable: vi.fn(async () => ({})) },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    cdpMock.mockResolvedValue(browserClient);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/browser-unfocused",
        }),
      })),
    );

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger, "about:blank", undefined, {
      hiddenTarget: true,
      fallbackToDefault: false,
    });

    expect(result.targetId).toBe("target-background-fallback");
    expect(browserClient.Target.createTarget).toHaveBeenNthCalledWith(1, {
      url: "about:blank",
      background: true,
      hidden: true,
      focus: false,
    });
    expect(browserClient.Target.createTarget).toHaveBeenNthCalledWith(2, {
      url: "about:blank",
      background: true,
      focus: false,
    });
    expect(browserClient.Target.createTarget).toHaveBeenCalledTimes(2);
    expect(logger).toHaveBeenCalledWith(
      "Hidden browser target unsupported (Hidden target can be created only when remote debugging is enabled); retrying with a dedicated background target in the Oracle hidden browser.",
    );
  });

  test("fails closed when both hidden and background target creation fail", async () => {
    const browserClient = {
      Target: {
        createTarget: vi
          .fn()
          .mockRejectedValueOnce(
            new Error("Hidden target can be created only when remote debugging is enabled"),
          )
          .mockRejectedValueOnce(new Error("Target creation rejected")),
        attachToTarget: vi.fn(),
        detachFromTarget: vi.fn(async () => ({})),
        closeTarget: vi.fn(async () => ({ success: true })),
      },
      Network: { enable: vi.fn(async () => ({})) },
      Page: { enable: vi.fn(async () => ({})), navigate: vi.fn(async () => ({})) },
      Runtime: {
        enable: vi.fn(async () => ({ result: {} })),
        evaluate: vi.fn(async () => ({ result: {} })),
      },
      Input: { dispatchKeyEvent: vi.fn(async () => ({})) },
      DOM: { enable: vi.fn(async () => ({})) },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    cdpMock.mockResolvedValue(browserClient);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/browser-unfocused",
        }),
      })),
    );

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    await expect(
      connectWithNewTab(9222, logger, "about:blank", undefined, {
        hiddenTarget: true,
        fallbackToDefault: false,
      }),
    ).rejects.toThrow(
      "Failed to open hidden browser target (Hidden target can be created only when remote debugging is enabled; background target retry failed: Target creation rejected); refusing to attach to a visible target.",
    );
    expect(browserClient.Target.createTarget).toHaveBeenCalledTimes(2);
  });

  test("does not run a polling focus guard when no deadline is provided", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const frontmostProcesses = [
      "Google Chrome\n4242\n",
      "Google Chrome\n4242\n",
      "Google Chrome\n4242\n",
      "Google Chrome\n4242\n",
      "Google Chrome\n4242\n",
    ];
    const execFileMock = vi.fn(
      (
        _file: string,
        args: string[],
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        const script = args[1] ?? args[0] ?? "";
        if (script.includes("first application process whose frontmost is true")) {
          callback(null, frontmostProcesses.shift() ?? "Google Chrome\n4242\n", "");
          return;
        }
        callback(null, "", "");
      },
    );
    Reflect.set(
      execFileMock as object,
      promisify.custom,
      (_file: string, args: string[]) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFileMock(_file, args, (error, stdout = "", stderr = "") => {
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        }),
    );

    vi.doMock("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { startChromeFocusGuard } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();
    const stop = startChromeFocusGuard(
      { pid: 4242 } as unknown as import("chrome-launcher").LaunchedChrome,
      logger,
      { name: "Zed", pid: 7001 },
      100,
    );

    await vi.advanceTimersByTimeAsync(600);
    stop();

    expect(execFileMock).not.toHaveBeenCalled();
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

  test("normalizes raw CDP target ids for reusable runtime attachment", async () => {
    cdpListMock.mockResolvedValue([
      { id: "target-1", type: "page", url: "https://chatgpt.com/" },
      { id: "target-2", type: "page", url: "about:blank" },
    ]);

    const { listRemoteChromeTargets } = await import("../../src/browser/chromeLifecycle.js");

    const targets = await listRemoteChromeTargets({
      host: "127.0.0.1",
      port: 9222,
    });

    expect(cdpListMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
    });
    expect(targets).toEqual([
      {
        id: "target-1",
        targetId: "target-1",
        type: "page",
        url: "https://chatgpt.com/",
      },
      {
        id: "target-2",
        targetId: "target-2",
        type: "page",
        url: "about:blank",
      },
    ]);
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

  test("times out browser websocket attach without an approval wait override", async () => {
    vi.useFakeTimers();
    cdpMock.mockImplementationOnce(() => new Promise(() => {}));

    const { connectToRemoteChromeTarget } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();
    const promise = connectToRemoteChromeTarget("127.0.0.1", 9222, logger, {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      targetId: "target-11",
    });
    const assertion = expect(promise).rejects.toThrow(
      /Timed out connecting to Chrome DevTools browser websocket at 127\.0\.0\.1:9222\./i,
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    expect(cdpMock).toHaveBeenCalledTimes(1);
    expect(logger).not.toHaveBeenCalledWith(
      "Waiting for Chrome remote debugging approval for 127.0.0.1:9222...",
    );
  });

  test("times out when attaching to a remote target through a browser websocket", async () => {
    vi.useFakeTimers();
    const browserClient = {
      Target: {
        getTargetInfo: vi.fn(async () => ({
          targetInfo: { targetId: "target-11", type: "page", url: "https://chatgpt.com/" },
        })),
        attachToTarget: vi.fn(() => new Promise(() => {})),
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
    cdpMock.mockResolvedValueOnce(browserClient);

    const { connectToRemoteChromeTarget } = await import("../../src/browser/chromeLifecycle.js");
    const promise = connectToRemoteChromeTarget("127.0.0.1", 9222, vi.fn() as never, {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      targetId: "target-11",
    });
    const assertion = expect(promise).rejects.toThrow(
      /Timed out attaching to remote Chrome target target-11 at 127\.0\.0\.1:9222\./i,
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    expect(browserClient.Target.getTargetInfo).toHaveBeenCalledWith({ targetId: "target-11" });
    expect(browserClient.Target.attachToTarget).toHaveBeenCalledWith({
      targetId: "target-11",
      flatten: true,
    });
    expect(browserClient.close).toHaveBeenCalledTimes(1);
  });

  test("times out when listing targets through a stalled browser websocket", async () => {
    vi.useFakeTimers();
    cdpMock.mockImplementationOnce(() => new Promise(() => {}));

    const { listRemoteChromeTargets } = await import("../../src/browser/chromeLifecycle.js");
    const promise = listRemoteChromeTargets({
      host: "127.0.0.1",
      port: 9222,
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
    });
    const assertion = expect(promise).rejects.toThrow(
      /Timed out connecting to Chrome DevTools browser websocket at 127\.0\.0\.1:9222 while listing targets\./i,
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    expect(cdpMock).toHaveBeenCalledTimes(1);
  });
});

describe("startChromeFocusGuard", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
  });

  test("does not poll or restore the prior frontmost app", async () => {
    const frontmostProcesses = [
      "Google Chrome\n4242\n",
      "Google Chrome\n4242\n",
      "Messages\n9001\n",
      "Google Chrome\n4242\n",
      "Google Chrome\n4242\n",
    ];
    const execFileMock = vi.fn(
      (
        _file: string,
        args: string[],
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        const script = args[1] ?? args[0] ?? "";
        if (script.includes("first application process whose frontmost is true")) {
          callback(null, frontmostProcesses.shift() ?? "Messages\n9001\n", "");
          return;
        }
        callback(null, "", "");
      },
    );
    Reflect.set(
      execFileMock as object,
      promisify.custom,
      (_file: string, args: string[]) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFileMock(_file, args, (error, stdout = "", stderr = "") => {
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        }),
    );

    vi.doMock("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { startChromeFocusGuard } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();
    const stop = startChromeFocusGuard(
      { pid: 4242 } as unknown as import("chrome-launcher").LaunchedChrome,
      logger,
      { name: "Zed", pid: 7001 },
      100,
      350,
    );

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(500);
    stop();

    const restoreScripts = execFileMock.mock.calls
      .map(([, args]) => args[1] ?? args[0] ?? "")
      .filter(
        (script) =>
          script.includes("set frontmost of") ||
          script.includes('tell application "Zed" to activate') ||
          script.includes('tell application "Messages" to activate'),
      );

    expect(restoreScripts).toEqual([]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("does not restore another app when hiding a background chrome process", async () => {
    const frontmostProcesses = ["Messages\n9001\n"];
    const execFileMock = vi.fn(
      (
        _file: string,
        args: string[],
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        const script = args[1] ?? args[0] ?? "";
        if (script.includes("first application process whose frontmost is true")) {
          callback(null, frontmostProcesses.shift() ?? "Messages\n9001\n", "");
          return;
        }
        callback(null, "", "");
      },
    );
    Reflect.set(
      execFileMock as object,
      promisify.custom,
      (_file: string, args: string[]) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFileMock(_file, args, (error, stdout = "", stderr = "") => {
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        }),
    );

    vi.doMock("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { hideChromeWindow } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    await hideChromeWindow(
      { pid: 4242 } as unknown as import("chrome-launcher").LaunchedChrome,
      logger,
      { name: "Zed", pid: 7001 },
    );

    const restoreScripts = execFileMock.mock.calls
      .map(([, args]) => args[1] ?? args[0] ?? "")
      .filter(
        (script) =>
          script.includes("set frontmost of") ||
          script.includes('tell application "Zed" to activate'),
      );

    expect(restoreScripts).toEqual([]);
  });

  test("does not treat a different Chrome pid as the managed hidden window", async () => {
    const frontmostProcesses = ["Google Chrome\n9999\n", "Google Chrome\n9999\n"];
    const execFileMock = vi.fn(
      (
        _file: string,
        args: string[],
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        const script = args[1] ?? args[0] ?? "";
        if (script.includes("first application process whose frontmost is true")) {
          callback(null, frontmostProcesses.shift() ?? "Google Chrome\n9999\n", "");
          return;
        }
        callback(null, "", "");
      },
    );
    Reflect.set(
      execFileMock as object,
      promisify.custom,
      (_file: string, args: string[]) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFileMock(_file, args, (error, stdout = "", stderr = "") => {
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        }),
    );

    vi.doMock("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { hideChromeWindow, startChromeFocusGuard } =
      await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    await hideChromeWindow(
      { pid: 4242 } as unknown as import("chrome-launcher").LaunchedChrome,
      logger,
      { name: "Zed", pid: 7001 },
    );

    const stop = startChromeFocusGuard(
      { pid: 4242 } as unknown as import("chrome-launcher").LaunchedChrome,
      logger,
      { name: "Zed", pid: 7001 },
      100,
      150,
    );
    await vi.advanceTimersByTimeAsync(200);
    stop();

    const restoreScripts = execFileMock.mock.calls
      .map(([, args]) => args[1] ?? args[0] ?? "")
      .filter(
        (script) =>
          script.includes("set frontmost of") ||
          script.includes('tell application "Zed" to activate'),
      );

    expect(restoreScripts).toEqual([]);
  });

  test("drops an initial Chrome restore target in hidden mode", async () => {
    const frontmostProcesses = ["Google Chrome\n4242\n"];
    const execFileMock = vi.fn(
      (
        _file: string,
        args: string[],
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        const script = args[1] ?? args[0] ?? "";
        if (script.includes("first application process whose frontmost is true")) {
          callback(null, frontmostProcesses.shift() ?? "Google Chrome\n4242\n", "");
          return;
        }
        callback(null, "", "");
      },
    );
    Reflect.set(
      execFileMock as object,
      promisify.custom,
      (_file: string, args: string[]) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFileMock(_file, args, (error, stdout = "", stderr = "") => {
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        }),
    );

    vi.doMock("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { hideChromeWindow } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    await hideChromeWindow(
      { pid: 4242 } as unknown as import("chrome-launcher").LaunchedChrome,
      logger,
      { name: "Google Chrome", pid: 4242 },
    );

    const restoreScripts = execFileMock.mock.calls
      .map(([, args]) => args[1] ?? args[0] ?? "")
      .filter((script) => script.includes("set frontmost of"));

    expect(restoreScripts).toEqual([]);
  });

  test("does not poll for another Chrome app or a prior non-Chrome app", async () => {
    const frontmostProcesses = [
      "Messages\n9001\n",
      "Google Chrome\n9999\n",
      "Google Chrome\n4242\n",
    ];
    const execFileMock = vi.fn(
      (
        _file: string,
        args: string[],
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        const script = args[1] ?? args[0] ?? "";
        if (script.includes("first application process whose frontmost is true")) {
          callback(null, frontmostProcesses.shift() ?? "Google Chrome\n4242\n", "");
          return;
        }
        callback(null, "", "");
      },
    );
    Reflect.set(
      execFileMock as object,
      promisify.custom,
      (_file: string, args: string[]) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFileMock(_file, args, (error, stdout = "", stderr = "") => {
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        }),
    );

    vi.doMock("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { startChromeFocusGuard } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const stop = startChromeFocusGuard(
      { pid: 4242 } as unknown as import("chrome-launcher").LaunchedChrome,
      logger,
      { name: "Zed", pid: 7001 },
      100,
      350,
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    stop();

    const restoreScripts = execFileMock.mock.calls
      .map(([, args]) => args[1] ?? args[0] ?? "")
      .filter(
        (script) =>
          script.includes("set frontmost of") ||
          script.includes('tell application "Zed" to activate') ||
          script.includes('tell application "Messages" to activate') ||
          script.includes('tell application "Google Chrome" to activate'),
      );

    expect(restoreScripts).toEqual([]);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
