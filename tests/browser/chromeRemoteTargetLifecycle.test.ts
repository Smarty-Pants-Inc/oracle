import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createBrowserLogger } from "./chromeLifecycleTestHelpers.js";

const { cdpMock, cdpNewMock, cdpCloseMock, cdpListMock } = vi.hoisted(() => {
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
  return { cdpMock, cdpNewMock, cdpCloseMock, cdpListMock };
});

vi.mock("chrome-remote-interface", () => ({ default: cdpMock }));

describe("connectToRemoteChrome", () => {
  beforeEach(() => {
    cdpMock.mockReset();
    cdpNewMock.mockReset();
    cdpCloseMock.mockReset();
    cdpListMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
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
    const logger = createBrowserLogger();

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
    cdpListMock.mockResolvedValue([
      { id: "borrowed-target", type: "page", url: "https://chatgpt.com/" },
    ]);
    cdpMock.mockResolvedValue(fallbackClient);

    const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
    const connection = await connectToRemoteChrome(
      "127.0.0.1",
      9222,
      vi.fn<(message: string) => void>(),
    );

    expect(cdpMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      target: "borrowed-target",
    });
    expect(connection.targetId).toBe("borrowed-target");
    expect(connection.ownership).toBe("attached");
    await connection.close();
    expect(fallbackClient.close).toHaveBeenCalledOnce();
    expect(cdpCloseMock).not.toHaveBeenCalled();
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
    const logger = createBrowserLogger();
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
    const logger = createBrowserLogger();
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
    const logger = createBrowserLogger();
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
