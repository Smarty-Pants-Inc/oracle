import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import type { BrowserLogger } from "../../src/browser/types.js";

describe("resolveAttachRunningConnection", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("defaults attach-running discovery to 127.0.0.1:9222", async () => {
    vi.doMock("../../src/browser/detect.js", () => ({
      discoverDevToolsActivePortCandidates: vi.fn(async () => [
        {
          port: 9222,
          browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/default",
          path: "/profiles/default/DevToolsActivePort",
          profileRoot: "/profiles/default",
          mtimeMs: 10,
        },
      ]),
    }));

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
    const logger = vi.fn();

    const result = await resolveAttachRunningConnection(
      { chromePath: null, remoteChrome: undefined },
      logger,
    );

    expect(result).toMatchObject({
      host: "127.0.0.1",
      port: 9222,
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/default",
      profileRoot: "/profiles/default",
      chromePid: null,
    });
    expect(logger).not.toHaveBeenCalledWith(
      expect.stringContaining("Waiting for Chrome remote debugging approval"),
    );
    expect(logger).toHaveBeenCalledWith(
      "Selected attach-running browser metadata from /profiles/default/DevToolsActivePort",
    );
  });

  test("plain attach-running through resolved browser config still uses discovery", async () => {
    vi.doMock("../../src/browser/detect.js", () => ({
      discoverDevToolsActivePortCandidates: vi.fn(async () => [
        {
          port: 9222,
          browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/default",
          path: "/profiles/default/DevToolsActivePort",
          profileRoot: "/profiles/default",
          mtimeMs: 10,
        },
      ]),
    }));

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
    const logger = vi.fn();
    const config = resolveBrowserConfig({
      attachRunning: true,
      manualLogin: false,
    });

    const result = await resolveAttachRunningConnection(config, logger);

    expect(result).toMatchObject({
      host: "127.0.0.1",
      port: 9222,
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/default",
      profileRoot: "/profiles/default",
      chromePid: null,
    });
    expect(logger).not.toHaveBeenCalledWith(expect.stringContaining("configured to use profile"));
  });

  test("uses remote-chrome as the attach-running hint and prefers the newest candidate", async () => {
    vi.doMock("../../src/browser/detect.js", () => ({
      discoverDevToolsActivePortCandidates: vi.fn(async () => [
        {
          port: 63332,
          browserWSEndpoint: "ws://127.0.0.1:63332/devtools/browser/older",
          path: "/profiles/dia-older/DevToolsActivePort",
          profileRoot: "/profiles/dia-older",
          mtimeMs: 5,
        },
        {
          port: 63332,
          browserWSEndpoint: "ws://127.0.0.1:63332/devtools/browser/newer",
          path: "/profiles/dia-newer/DevToolsActivePort",
          profileRoot: "/profiles/dia-newer",
          mtimeMs: 20,
        },
      ]),
    }));

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
    const logger = vi.fn();

    const result = await resolveAttachRunningConnection(
      {
        chromePath: "/Applications/Dia.app/Contents/MacOS/Dia",
        remoteChrome: { host: "127.0.0.1", port: 63332 },
      },
      logger,
    );

    expect(result).toMatchObject({
      host: "127.0.0.1",
      port: 63332,
      browserWSEndpoint: "ws://127.0.0.1:63332/devtools/browser/newer",
      profileRoot: "/profiles/dia-newer",
      chromePid: null,
    });
    expect(logger).toHaveBeenCalledWith(
      "Note: --browser-chrome-path is ignored when --browser-attach-running is enabled.",
    );
    expect(logger).toHaveBeenCalledWith(
      "Selected attach-running browser metadata from /profiles/dia-newer/DevToolsActivePort",
    );
  });

  test("rejects attach-running when no local DevToolsActivePort matches the selected port", async () => {
    vi.doMock("../../src/browser/detect.js", () => ({
      discoverDevToolsActivePortCandidates: vi.fn(async () => []),
    }));

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
    const logger = vi.fn() as BrowserLogger;

    await expect(
      resolveAttachRunningConnection(
        {
          chromePath: null,
          remoteChrome: { host: "127.0.0.1", port: 63332 },
        },
        logger,
      ),
    ).rejects.toThrow(/No running browser with attach metadata matched 127\.0\.0\.1:63332/i);
  });

  test("fails closed when a hinted attach-running profile has no DevTools metadata", async () => {
    vi.doMock("../../src/browser/detect.js", () => ({
      discoverDevToolsActivePortCandidates: vi.fn(async () => [
        {
          port: 9222,
          browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/other",
          path: "/profiles/other/DevToolsActivePort",
          profileRoot: "/profiles/other",
          mtimeMs: 20,
        },
      ]),
      readDevToolsActivePortInfo: vi.fn(async () => null),
    }));

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");

    await expect(
      resolveAttachRunningConnection(
        {
          chromePath: null,
          remoteChrome: undefined,
          manualLoginProfileDir: "/profiles/oracle",
        },
        vi.fn() as BrowserLogger,
      ),
    ).rejects.toThrow(/configured to use profile \/profiles\/oracle/i);
  });

  test("prefers the configured manual-login profile hint when attach-running uses a dynamic port", async () => {
    vi.doMock("../../src/browser/detect.js", () => ({
      discoverDevToolsActivePortCandidates: vi.fn(async () => []),
      readDevToolsActivePortInfo: vi.fn(async () => ({
        port: 57564,
        browserWSEndpoint: "ws://127.0.0.1:57564/devtools/browser/profile-hint",
        path: "/profiles/oracle/DevToolsActivePort",
      })),
    }));
    vi.doMock("../../src/browser/profileState.js", () => ({
      readChromePid: vi.fn(async () => 21317),
    }));

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
    const logger = vi.fn();

    const result = await resolveAttachRunningConnection(
      {
        chromePath: null,
        remoteChrome: undefined,
        manualLoginProfileDir: "/profiles/oracle",
      },
      logger,
    );

    expect(result).toMatchObject({
      host: "127.0.0.1",
      port: 57564,
      browserWSEndpoint: "ws://127.0.0.1:57564/devtools/browser/profile-hint",
      profileRoot: "/profiles/oracle",
      chromePid: 21317,
    });
    expect(logger).toHaveBeenCalledWith(
      "Selected attach-running browser metadata from /profiles/oracle/DevToolsActivePort",
    );
  });
});
