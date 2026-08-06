import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  closeBlankChromeTabsWithExactAuthority,
  closeChromeTargetWithExactAuthority,
} from "../../src/browser/chromeLifecycle.js";
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
    const logger = createBrowserLogger();

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

  test("does not close replacement blank tabs after the exact generation exits", async () => {
    const exactClient = {
      Target: {
        getTargets: vi.fn(async () => ({
          targetInfos: [
            { targetId: "blank-a", type: "page", url: "about:blank" },
            { targetId: "blank-b", type: "page", url: "about:blank" },
          ],
        })),
        closeTarget: vi.fn(async () => ({ success: true })),
      },
    };
    const runExactOperation = vi
      .fn()
      .mockImplementationOnce(async (operation) => ({
        status: "completed",
        value: await operation(exactClient),
      }))
      .mockResolvedValueOnce({ status: "gone" });
    const authority = {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/exact-old-generation",
      kill: vi.fn(),
      runExactOperation,
      release: vi.fn(),
    };

    await expect(
      closeBlankChromeTabsWithExactAuthority(
        authority as never,
        vi.fn<(message: string) => void>(),
        { preserveOneBlank: true },
      ),
    ).resolves.toEqual({ status: "gone" });
    expect(runExactOperation).toHaveBeenCalledTimes(2);
    expect(exactClient.Target.closeTarget).not.toHaveBeenCalled();
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
  test("does not close a generation B target after generation A exits", async () => {
    const generationAClose = vi.fn(async () => ({ success: true }));
    const generationBClose = vi.fn(async () => ({ success: true }));
    const exactClientA = {
      Target: {
        getTargets: vi.fn(async () => ({
          targetInfos: [
            { targetId: "target-a", type: "page", url: "about:blank" },
            { targetId: "other-a", type: "page", url: "about:blank" },
          ],
        })),
        closeTarget: generationAClose,
      },
    };
    const exactClientB = { Target: { closeTarget: generationBClose } };
    let operationCount = 0;
    const authority = {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/generation-a",
      kill: vi.fn(),
      runExactOperation: vi.fn(async (operation: (client: never) => Promise<unknown>) => {
        operationCount += 1;
        if (operationCount === 1) {
          return { status: "completed" as const, value: await operation(exactClientA as never) };
        }
        void exactClientB;
        return { status: "gone" as const };
      }),
      release: vi.fn(),
    };

    await expect(
      closeChromeTargetWithExactAuthority({
        authority: authority as never,
        targetId: "target-a",
        logger: createBrowserLogger(),
      }),
    ).resolves.toEqual({ status: "gone" });
    expect(generationAClose).not.toHaveBeenCalled();
    expect(generationBClose).not.toHaveBeenCalled();
    expect(cdpCloseMock).not.toHaveBeenCalled();
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
});
