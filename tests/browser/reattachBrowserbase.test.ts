import { afterEach, describe, expect, test, vi } from "vitest";
import type { BrowserLogger } from "../../src/browser/types.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";

afterEach(() => {
  vi.doUnmock("../../src/browser/chromeLifecycle.js");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("Browserbase reattach recovery", () => {
  test("resumeBrowserSession refuses to recover by launching local Chrome", async () => {
    const { resumeBrowserSession, launchChrome } = await loadReattachWithLaunchGuard();
    const logger = vi.fn() as BrowserLogger;
    const runtime: BrowserRuntimeMetadata = {
      browserProvider: "browserbase",
      browserbaseSessionId: "bb-session-1",
      browserbaseKeepAlive: false,
      tabUrl: "https://chatgpt.com/c/browserbase-thread",
      conversationId: "browserbase-thread",
    };

    await expect(resumeBrowserSession(runtime, {}, logger)).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: expect.objectContaining({ stage: "browserbase-reattach-unavailable" }),
    });
    expect(launchChrome).not.toHaveBeenCalled();
  });

  test("continueBrowserSession refuses to recover by launching local Chrome", async () => {
    const { continueBrowserSession, launchChrome } = await loadReattachWithLaunchGuard();
    const logger = vi.fn() as BrowserLogger;
    const runtime: BrowserRuntimeMetadata = {
      browserProvider: "browserbase",
      browserbaseSessionId: "bb-session-1",
      browserbaseKeepAlive: false,
      tabUrl: "https://chatgpt.com/c/browserbase-thread",
      conversationId: "browserbase-thread",
    };

    await expect(
      continueBrowserSession(runtime, {}, logger, { prompt: "continue" }),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: expect.objectContaining({ stage: "browserbase-reattach-unavailable" }),
    });
    expect(launchChrome).not.toHaveBeenCalled();
  });
});

async function loadReattachWithLaunchGuard() {
  const launchChrome = vi.fn(async () => {
    throw new Error("local Chrome launched");
  });
  vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
    const original = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
      "../../src/browser/chromeLifecycle.js",
    );
    return {
      ...original,
      launchChrome,
    };
  });
  const reattach = await import("../../src/browser/reattach.js");
  return { ...reattach, launchChrome };
}
