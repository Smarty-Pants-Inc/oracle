import { afterEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { maybeReuseRunningChromeForTest } from "../../src/browser/index.js";

const noopLogger = () => {};

describe("maybeReuseRunningChrome", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("waits for a shared Chrome port before reusing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-reuse-"));
    const port = 9222;

    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await fs.writeFile(
        path.join(tmpDir, "DevToolsActivePort"),
        `${port}\n/devtools/browser`,
        "utf8",
      );
    })();

    const probe = vi.fn(async () => ({ ok: true as const }));
    const reusePromise = maybeReuseRunningChromeForTest(tmpDir, noopLogger, {
      waitForPortMs: 1000,
      probe,
    });

    const reused = await reusePromise;
    expect(reused?.port).toBe(port);
    expect(probe).toHaveBeenCalled();

    await fs.rm(tmpDir, { recursive: true, force: true });
  }, 10_000);

  test("returns null immediately when no port and no wait", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-reuse-"));
    const probe = vi.fn(async () => ({ ok: true as const }));
    const reused = await maybeReuseRunningChromeForTest(tmpDir, noopLogger, {
      waitForPortMs: 0,
      probe,
    });
    expect(reused).toBeNull();
    expect(probe).not.toHaveBeenCalled();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("keeps waiting when the chrome pid is alive but DevTools is not ready yet", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-reuse-"));
    const port = 9333;
    await fs.writeFile(path.join(tmpDir, "chrome.pid"), `${process.pid}\n`, "utf8");
    await fs.writeFile(
      path.join(tmpDir, "DevToolsActivePort"),
      `${port}\n/devtools/browser`,
      "utf8",
    );

    let attempt = 0;
    const probe = vi.fn(async () => {
      attempt += 1;
      return attempt >= 2
        ? { ok: true as const }
        : { ok: false as const, error: "connection refused" };
    });

    const reusePromise = maybeReuseRunningChromeForTest(tmpDir, noopLogger, {
      waitForPortMs: 1_000,
      probe,
    });

    const reused = await reusePromise;
    expect(reused?.port).toBe(port);
    expect(probe).toHaveBeenCalledTimes(2);

    await fs.rm(tmpDir, { recursive: true, force: true });
  }, 10_000);

  test("fails closed instead of launching another chrome when the profile owner is still alive", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-reuse-"));
    const port = 9333;
    await fs.writeFile(path.join(tmpDir, "chrome.pid"), `${process.pid}\n`, "utf8");
    await fs.writeFile(
      path.join(tmpDir, "DevToolsActivePort"),
      `${port}\n/devtools/browser`,
      "utf8",
    );

    const probe = vi.fn(async () => ({ ok: false as const, error: "connection refused" }));

    await expect(
      maybeReuseRunningChromeForTest(tmpDir, noopLogger, {
        waitForPortMs: 250,
        probe,
        failOnLiveChromeWithoutDevtools: true,
      }),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: expect.objectContaining({
        stage: "manual-login-devtools-unreachable",
        chromePid: process.pid,
        userDataDir: tmpDir,
      }),
    });

    await fs.rm(tmpDir, { recursive: true, force: true });
  }, 10_000);
});
