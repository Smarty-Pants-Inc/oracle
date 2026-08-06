import { describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chromeLaunchResult,
  createBrowserLogger,
  physicalProcessIdentity,
} from "./chromeLifecycleTestHelpers.js";
const UNUSED_PROFILE_USE = Object.freeze({
  status: "unused" as const,
  candidates: Object.freeze([]),
});
const PROFILE_DIRECTORY_USE_DEPS = Object.freeze({
  inspectChromeProfileDirectoryUse: async () => UNUSED_PROFILE_USE,
  revalidateChromeProfileDirectoryUse: async () => UNUSED_PROFILE_USE,
});

describe("registerTerminationHooks", { timeout: 15_000 }, () => {
  test("removes a copied profile only after safe retained-handle termination", async () => {
    const { registerTerminationHooks } = await import("../../src/browser/chromeLifecycle.js");
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "oracle-copy-profile-signal-"));
    await writeFile(path.join(userDataDir, "Cookies"), "sensitive");
    const identity = await physicalProcessIdentity(
      userDataDir,
      1234,
      "66666666-6666-4666-8666-666666666666",
    );
    const kill = vi.fn(async () => ({
      status: "stopped" as const,
      pid: 1234,
      signal: "SIGTERM" as const,
    }));
    const chrome = chromeLaunchResult(identity, kill);
    const emitRuntimeHint = vi.fn().mockResolvedValue(undefined);
    const handled = Promise.withResolvers<void>();
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
        profileDirectoryUseDeps: PROFILE_DIRECTORY_USE_DEPS,
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
    const identity = await physicalProcessIdentity(
      userDataDir,
      1235,
      "77777777-7777-4777-8777-777777777777",
    );
    const kill = vi.fn(async () => ({
      status: "unsafe" as const,
      pid: 1235,
      reason: "stable handle unavailable",
    }));
    const chrome = chromeLaunchResult(identity, kill);
    const logger = vi.fn<(message: string) => void>();
    const handled = Promise.withResolvers<void>();
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
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "oracle-manual-login-profile-"));
    const identity = await physicalProcessIdentity(
      userDataDir,
      1236,
      "88888888-8888-4888-8888-888888888888",
    );
    const devToolsActivePort = path.join(userDataDir, "DevToolsActivePort");
    await writeFile(devToolsActivePort, "9222\n/devtools/browser/stale\n");
    const kill = vi.fn(async () => ({
      status: "stopped" as const,
      pid: 1236,
      signal: "SIGTERM" as const,
    }));
    const chrome = chromeLaunchResult(identity, kill);
    const logger = vi.fn<(message: string) => void>();
    const handled = Promise.withResolvers<void>();
    const removeHooks = registerTerminationHooks(chrome, userDataDir, false, logger, {
      preserveUserDataDir: true,
      profileDirectoryUseDeps: PROFILE_DIRECTORY_USE_DEPS,
      onSignalHandled: () => handled.resolve(),
    });
    try {
      process.emit("SIGINT");
      await handled.promise;
      expect(existsSync(devToolsActivePort)).toBe(false);
    } finally {
      removeHooks();
      await rm(userDataDir, { recursive: true, force: true });
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
    const logger = createBrowserLogger();

    await positionChromeWindowOffscreen({ Browser: browser } as never, logger);

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
