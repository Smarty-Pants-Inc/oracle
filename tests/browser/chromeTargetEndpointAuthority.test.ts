import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { connectWithNewTabWithExactAuthority } from "../../src/browser/chromeLifecycle.js";
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
    const logger = createBrowserLogger();

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
    const logger = createBrowserLogger();

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
    const logger = createBrowserLogger();

    await expect(
      connectWithNewTab(9222, logger, undefined, undefined, { fallbackToDefault: false }),
    ).rejects.toThrow(/isolated browser tab/i);
    expect(cdpMock).not.toHaveBeenCalled();
  });

  test("returns isolated target when attach succeeds", async () => {
    cdpNewMock.mockResolvedValue({ id: "target-2" });
    cdpMock.mockResolvedValue({});

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = createBrowserLogger();

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
    const logger = createBrowserLogger();

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

  test("creates and attaches a new tab through the retained exact browser session", async () => {
    const exactBrowser = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "generation-a-target" })),
        attachToTarget: vi.fn(async () => ({ sessionId: "generation-a-session" })),
        detachFromTarget: vi.fn(async () => undefined),
        closeTarget: vi.fn(async () => ({ success: true })),
      },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    };
    const authority = {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/generation-a",
      kill: vi.fn(),
      runExactOperation: vi.fn(async (operation: (client: never) => Promise<unknown>) => ({
        status: "completed" as const,
        value: await operation(exactBrowser as never),
      })),
      release: vi.fn(),
    };

    const connection = await connectWithNewTabWithExactAuthority(
      authority as never,
      createBrowserLogger(),
      "about:blank#generation-a",
    );

    expect(connection.targetId).toBe("generation-a-target");
    expect(exactBrowser.Target.createTarget).toHaveBeenCalledWith({
      url: "about:blank#generation-a",
    });
    expect(exactBrowser.Target.attachToTarget).toHaveBeenCalledWith({
      targetId: "generation-a-target",
      flatten: true,
    });
    expect(cdpNewMock).not.toHaveBeenCalled();
    expect(cdpMock).not.toHaveBeenCalled();
    await connection.client.close();
    expect(exactBrowser.Target.detachFromTarget).toHaveBeenCalledWith({
      sessionId: "generation-a-session",
    });
  });

  test("does not create or attach through generation B after same-port rebinding", async () => {
    const generationBCreate = vi.fn(async () => ({ id: "generation-b-target" }));
    const generationBAttach = vi.fn();
    cdpNewMock.mockImplementation(generationBCreate);
    cdpMock.mockImplementation(generationBAttach);
    const authority = {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/generation-a",
      kill: vi.fn(),
      runExactOperation: vi.fn(async () => ({ status: "gone" as const })),
      release: vi.fn(),
    };

    await expect(
      connectWithNewTabWithExactAuthority(authority as never, createBrowserLogger()),
    ).rejects.toThrow(/generation exited/i);
    expect(generationBCreate).not.toHaveBeenCalled();
    expect(generationBAttach).not.toHaveBeenCalled();
  });

  test("failure-closes a created target on generation A without a port fallback", async () => {
    const exactBrowser = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "generation-a-target" })),
        attachToTarget: vi.fn(async () => {
          throw new Error("attach failed");
        }),
        closeTarget: vi.fn(async () => ({ success: true })),
      },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    };
    const authority = {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/generation-a",
      kill: vi.fn(),
      runExactOperation: vi.fn(async (operation: (client: never) => Promise<unknown>) => ({
        status: "completed" as const,
        value: await operation(exactBrowser as never),
      })),
      release: vi.fn(),
    };

    await expect(
      connectWithNewTabWithExactAuthority(authority as never, createBrowserLogger()),
    ).rejects.toThrow("attach failed");
    expect(exactBrowser.Target.closeTarget).toHaveBeenCalledWith({
      targetId: "generation-a-target",
    });
    expect(cdpCloseMock).not.toHaveBeenCalled();
    expect(cdpNewMock).not.toHaveBeenCalled();
    expect(cdpMock).not.toHaveBeenCalled();
  });
});
