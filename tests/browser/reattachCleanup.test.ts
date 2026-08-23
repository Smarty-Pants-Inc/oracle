import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as ChromeLifecycle from "../../src/browser/chromeLifecycle.js";
import type { BrowserLogger } from "../../src/browser/types.js";

const chromeLifecycleMocks = vi.hoisted(() => ({
  connectToChrome: vi.fn(),
  launchChrome: vi.fn(),
}));

vi.mock("../../src/browser/chromeLifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ChromeLifecycle>()),
  ...chromeLifecycleMocks,
}));

import { resumeBrowserSession } from "../../src/browser/reattach.js";

afterEach(() => {
  chromeLifecycleMocks.connectToChrome.mockReset();
  chromeLifecycleMocks.launchChrome.mockReset();
});

describe("new Chrome reattach cleanup", () => {
  test("waits for deferred Chrome termination before clearing its profile state", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-profile-"));
    const activePortPath = path.join(profileDir, "DevToolsActivePort");
    await writeFile(activePortPath, "9222\n/devtools/browser/test\n");
    let resolveKill: (() => void) | undefined;
    let signalKillStarted: (() => void) | undefined;
    const killStarted = new Promise<void>((resolve) => {
      signalKillStarted = resolve;
    });
    const killFinished = new Promise<void>((resolve) => {
      resolveKill = resolve;
    });
    const kill = vi.fn(() => {
      signalKillStarted?.();
      return killFinished;
    });
    chromeLifecycleMocks.launchChrome.mockResolvedValue({ kill, pid: 1, port: 9222 });
    chromeLifecycleMocks.connectToChrome.mockRejectedValue(new Error("connect failed"));

    try {
      const result = resumeBrowserSession(
        {},
        { manualLogin: true, manualLoginProfileDir: profileDir },
        vi.fn() as BrowserLogger,
      );
      await killStarted;
      await expect(stat(activePortPath)).resolves.toBeDefined();

      resolveKill?.();
      await expect(result).rejects.toThrow("connect failed");
      await expect(stat(activePortPath)).rejects.toThrow();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("continues profile cleanup when asynchronous Chrome termination rejects", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-profile-"));
    const activePortPath = path.join(profileDir, "DevToolsActivePort");
    await writeFile(activePortPath, "9222\n/devtools/browser/test\n");
    const kill = vi.fn().mockRejectedValue(new Error("kill failed"));
    chromeLifecycleMocks.launchChrome.mockResolvedValue({ kill, pid: 1, port: 9222 });
    chromeLifecycleMocks.connectToChrome.mockRejectedValue(new Error("connect failed"));

    try {
      await expect(
        resumeBrowserSession(
          {},
          { manualLogin: true, manualLoginProfileDir: profileDir },
          vi.fn() as BrowserLogger,
        ),
      ).rejects.toThrow("connect failed");
      expect(kill).toHaveBeenCalledOnce();
      await expect(stat(activePortPath)).rejects.toThrow();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });
});
