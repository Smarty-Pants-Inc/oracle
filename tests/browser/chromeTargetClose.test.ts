import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { closeChromeTargetWithExactAuthority } from "../../src/browser/chromeLifecycle.js";
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

  test("retains a replacement page while closing through retained endpoint authority", async () => {
    vi.useFakeTimers();
    const exactClient = {
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
    };
    const authority = {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/generation-a",
      kill: vi.fn(),
      release: vi.fn(),
      runExactOperation: vi.fn(async (operation: (client: never) => Promise<unknown>) => ({
        status: "completed" as const,
        value: await operation(exactClient as never),
      })),
    };

    const closing = closeChromeTargetWithExactAuthority({
      authority: authority as never,
      targetId: "owned",
      logger: createBrowserLogger(),
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(closing).resolves.toEqual({ status: "completed" });
    expect(exactClient.Target.createTarget).toHaveBeenCalledWith({ url: "about:blank" });
    expect(exactClient.Target.closeTarget).toHaveBeenCalledWith({ targetId: "owned" });
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
