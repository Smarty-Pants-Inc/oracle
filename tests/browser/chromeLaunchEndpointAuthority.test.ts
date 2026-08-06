import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import type { ChromeProcessIdentity } from "../../src/browser/chromeProcessIdentity.js";
import {
  chromeLaunchResult,
  processIdentity,
  resolveLocalChromeLaunchRoute,
  syntheticProfileIdentity,
} from "./chromeLifecycleTestHelpers.js";

describe("hidden macOS Chrome launch", () => {
  test("retains the exact hidden-launch control authority", async () => {
    const { launchChrome } = await import("../../src/browser/chromeLifecycle.js");
    const { resolveBrowserConfig } = await import("../../src/browser/config.js");
    const profile = syntheticProfileIdentity(path.join(os.tmpdir(), "oracle-hidden-profile"));
    const identity = processIdentity(
      profile.canonicalPath,
      4321,
      "11111111-1111-4111-8111-111111111111",
    );
    const stableKill = vi.fn(async () => ({
      status: "stopped" as const,
      pid: identity.pid,
      signal: "CONTROL_CHANNEL" as const,
    }));
    const hiddenMacLaunch = vi.fn(async () => chromeLaunchResult(identity, stableKill));
    const standardLaunch = vi.fn();
    const writeOwner = vi.fn(async () => undefined);
    const logger = vi.fn<(message: string) => void>();

    const launched = await launchChrome(
      resolveBrowserConfig({ hideWindow: true, debugPort: 9222 }),
      profile.canonicalPath,
      logger,
      {
        platform: "darwin",
        resolveLaunchRoute: resolveLocalChromeLaunchRoute,
        hiddenMacLaunch,
        standardLaunch,
        captureProfileIdentity: async () => profile,
        launchClaim: identity.launchClaim,
        writeOwner,
      },
    );

    expect(hiddenMacLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        userDataDir: profile.canonicalPath,
        requestedPort: 9222,
        launchClaim: identity.launchClaim,
        chromeFlags: expect.arrayContaining([
          `--oracle-launch-claim=${identity.launchClaim.generationId}:${identity.launchClaim.nonce}`,
        ]),
      }),
    );
    expect(standardLaunch).not.toHaveBeenCalled();
    expect(writeOwner).toHaveBeenCalledWith(profile.canonicalPath, {
      port: 9222,
      processIdentity: identity,
      disposition: "close-on-last-lease",
    });
    await expect(launched.kill()).resolves.toMatchObject({
      status: "stopped",
      signal: "CONTROL_CHANNEL",
    });
    expect(stableKill).toHaveBeenCalledOnce();
  });

  test("publishes the requested preserve disposition on the first owner write", async () => {
    // Dynamic imports keep this launch assertion bound to Vitest's hoisted CDP mock.
    const { launchChrome } = await import("../../src/browser/chromeLifecycle.js");
    const { resolveBrowserConfig } = await import("../../src/browser/config.js");
    const profile = syntheticProfileIdentity(path.join(os.tmpdir(), "oracle-preserved-profile"));
    const identity = processIdentity(
      profile.canonicalPath,
      4322,
      "11111111-1111-4111-8111-111111111114",
    );
    const hiddenMacLaunch = vi.fn(async () =>
      chromeLaunchResult(
        identity,
        vi.fn(async () => ({
          status: "stopped" as const,
          pid: identity.pid,
          signal: "CONTROL_CHANNEL" as const,
        })),
      ),
    );
    const writeOwner = vi.fn(async () => undefined);

    await launchChrome(
      resolveBrowserConfig({ hideWindow: true, debugPort: 9222, keepBrowser: true }),
      profile.canonicalPath,
      vi.fn<(message: string) => void>(),
      {
        platform: "darwin",
        resolveLaunchRoute: resolveLocalChromeLaunchRoute,
        hiddenMacLaunch,
        captureProfileIdentity: async () => profile,
        launchClaim: identity.launchClaim,
        writeOwner,
      },
    );

    expect(writeOwner).toHaveBeenCalledOnce();
    expect(writeOwner).toHaveBeenCalledWith(profile.canonicalPath, {
      port: 9222,
      processIdentity: identity,
      disposition: "preserve",
    });
  });

  test("builds an open command that is hidden, backgrounded, and isolated", async () => {
    const { buildHiddenMacChromeOpenArgs } = await import("../../src/browser/chromeLifecycle.js");
    expect(
      buildHiddenMacChromeOpenArgs("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
        "--remote-debugging-port=9222",
        "about:blank",
      ]),
    ).toEqual([
      "-g",
      "-j",
      "-n",
      "/Applications/Google Chrome.app",
      "--args",
      "--remote-debugging-port=9222",
      "about:blank",
    ]);
  });

  test("fails closed when hidden headful launch cannot be guaranteed", async () => {
    const { launchChrome } = await import("../../src/browser/chromeLifecycle.js");
    const { resolveBrowserConfig } = await import("../../src/browser/config.js");
    const profile = syntheticProfileIdentity(path.join(os.tmpdir(), "oracle-hidden-profile"));
    await expect(
      launchChrome(
        resolveBrowserConfig({ hideWindow: true }),
        profile.canonicalPath,
        vi.fn<(message: string) => void>(),
        { platform: "linux", captureProfileIdentity: async () => profile },
      ),
    ).rejects.toThrow(/use --remote-chrome/i);
  });

  test("does not claim stopped until the exact hidden Chrome generation exits", async () => {
    const { createIdentityBoundChromeControlKillForTest } =
      await import("../../src/browser/chromeLifecycle.js");
    const identity = processIdentity(
      path.join(os.tmpdir(), "oracle-hidden-profile"),
      4321,
      "11111111-1111-4111-8111-111111111112",
    );
    const browserClose = vi.fn(async () => undefined);
    const clientClose = vi.fn(async () => undefined);
    const inspectProcessIdentity = vi
      .fn()
      .mockResolvedValueOnce("current" as const)
      .mockResolvedValueOnce("current" as const)
      .mockResolvedValueOnce("exited" as const);
    const kill = createIdentityBoundChromeControlKillForTest(
      { Browser: { close: browserClose }, close: clientClose } as never,
      identity.profileDirectory.canonicalPath,
      identity,
      { inspectProcessIdentity, timeoutMs: 0 },
    );

    await expect(kill()).resolves.toMatchObject({
      status: "unsafe",
      pid: identity.pid,
      reason: expect.stringMatching(/remained alive/i),
    });
    await expect(kill()).resolves.toMatchObject({
      status: "stopped",
      pid: identity.pid,
      signal: "CONTROL_CHANNEL",
    });
    expect(browserClose).toHaveBeenCalledOnce();
    expect(clientClose).toHaveBeenCalledOnce();
    expect(inspectProcessIdentity).toHaveBeenCalledTimes(3);
  });

  test("retries control-channel release before reporting a terminal stop", async () => {
    // Dynamic import keeps this control assertion bound to Vitest's hoisted CDP mock.
    const { createIdentityBoundChromeControlKillForTest } =
      await import("../../src/browser/chromeLifecycle.js");
    const identity = processIdentity(
      path.join(os.tmpdir(), "oracle-hidden-profile"),
      4323,
      "11111111-1111-4111-8111-111111111115",
    );
    const browserClose = vi.fn(async () => undefined);
    const clientClose = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient close failure"))
      .mockResolvedValueOnce(undefined);
    const inspectProcessIdentity = vi
      .fn()
      .mockResolvedValueOnce("current" as const)
      .mockResolvedValueOnce("exited" as const)
      .mockResolvedValueOnce("exited" as const);
    const kill = createIdentityBoundChromeControlKillForTest(
      { Browser: { close: browserClose }, close: clientClose } as never,
      identity.profileDirectory.canonicalPath,
      identity,
      { inspectProcessIdentity, timeoutMs: 0 },
    );

    await expect(kill()).resolves.toMatchObject({
      status: "unsafe",
      pid: identity.pid,
      reason: expect.stringMatching(/release failed.*transient close failure/i),
    });
    await expect(kill()).resolves.toMatchObject({
      status: "stopped",
      pid: identity.pid,
      signal: "CONTROL_CHANNEL",
    });
    await expect(kill()).resolves.toMatchObject({ status: "stopped", pid: identity.pid });
    expect(browserClose).toHaveBeenCalledOnce();
    expect(clientClose).toHaveBeenCalledTimes(2);
    expect(inspectProcessIdentity).toHaveBeenCalledTimes(3);
  });

  test("accepts matching and rejects mismatched or unresolved listener ownership on every platform", async () => {
    // Dynamic import keeps this endpoint assertion bound to Vitest's hoisted CDP mock.
    const { retainChromeEndpointAuthority } = await import("../../src/browser/chromeLifecycle.js");
    const cases: ReadonlyArray<{ platform: NodeJS.Platform; processStartTime: string }> = [
      { platform: "darwin", processStartTime: "darwin-audit-pidversion:7001" },
      {
        platform: "linux",
        processStartTime: "linux:11111111-1111-4111-8111-111111111111:987654",
      },
      { platform: "win32", processStartTime: "win32:2026-08-06T12:34:56.1234567Z" },
    ];

    for (const { platform, processStartTime } of cases) {
      const baseIdentity = processIdentity(
        path.join(os.tmpdir(), `oracle-${platform}-listener-profile`),
        4321,
        "11111111-1111-4111-8111-111111111113",
      );
      const identity: ChromeProcessIdentity = {
        ...baseIdentity,
        processStartTime,
        profileDirectory: { ...baseIdentity.profileDirectory, platform },
      };
      const browserWSEndpoint = `ws://127.0.0.1:64305/devtools/browser/${platform}-generation`;
      const discoverEndpoint = vi.fn(async () => ({ port: 64305, browserWSEndpoint }));
      const exactClientClose = vi.fn(async () => undefined);
      const exactClient = {
        Browser: { getVersion: vi.fn(async () => ({})), close: vi.fn(async () => undefined) },
        close: exactClientClose,
      };
      const exactOwner =
        platform === "darwin"
          ? { pid: identity.pid }
          : { pid: identity.pid, processGeneration: identity.processStartTime };
      const authority = await retainChromeEndpointAuthority(
        {
          host: "127.0.0.1",
          port: 64305,
          browserWSEndpoint,
          userDataDir: identity.profileDirectory.canonicalPath,
          processIdentity: identity,
        },
        {
          discoverEndpoint,
          connectBrowser: vi.fn(async () => exactClient as never),
          inspectProcessIdentity: vi.fn(async () => "current" as const),
          resolveListeningOwner: vi.fn(async () => exactOwner),
        },
      );
      expect(authority.browserWSEndpoint).toBe(browserWSEndpoint);
      await authority.release();
      expect(exactClientClose).toHaveBeenCalledOnce();

      const mismatchedConnect = vi.fn();
      await expect(
        retainChromeEndpointAuthority(
          {
            host: "127.0.0.1",
            port: 64305,
            browserWSEndpoint,
            userDataDir: identity.profileDirectory.canonicalPath,
            processIdentity: identity,
          },
          {
            discoverEndpoint,
            connectBrowser: mismatchedConnect,
            inspectProcessIdentity: vi.fn(async () => "current" as const),
            resolveListeningOwner: vi.fn(async () => ({
              pid: 9999,
              processGeneration: identity.processStartTime,
            })),
          },
        ),
      ).rejects.toThrow(/listener no longer belongs to the exact Chrome process/i);
      expect(mismatchedConnect).not.toHaveBeenCalled();

      const unresolvedConnect = vi.fn();
      await expect(
        retainChromeEndpointAuthority(
          {
            host: "127.0.0.1",
            port: 64305,
            browserWSEndpoint,
            userDataDir: identity.profileDirectory.canonicalPath,
            processIdentity: identity,
          },
          {
            discoverEndpoint,
            connectBrowser: unresolvedConnect,
            inspectProcessIdentity: vi.fn(async () => "current" as const),
            resolveListeningOwner: vi.fn(async () => null),
          },
        ),
      ).rejects.toThrow(/listener ownership could not be resolved/i);
      expect(unresolvedConnect).not.toHaveBeenCalled();
    }
  });

  test("blocks operations and kill after same-pid listener generation reuse", async () => {
    // Dynamic import keeps this endpoint assertion bound to Vitest's hoisted CDP mock.
    const { retainChromeEndpointAuthority } = await import("../../src/browser/chromeLifecycle.js");
    const baseIdentity = processIdentity(
      path.join(os.tmpdir(), "oracle-linux-reused-profile"),
      4321,
      "11111111-1111-4111-8111-111111111114",
    );
    const identity: ChromeProcessIdentity = {
      ...baseIdentity,
      processStartTime: "linux:11111111-1111-4111-8111-111111111111:987654",
      profileDirectory: { ...baseIdentity.profileDirectory, platform: "linux" },
    };
    const browserWSEndpoint = "ws://127.0.0.1:64305/devtools/browser/exact-generation";
    const discoverEndpoint = vi.fn(async () => ({ port: 64305, browserWSEndpoint }));
    let listenerGeneration = identity.processStartTime;
    const browserClose = vi.fn(async () => undefined);
    const endpointClose = vi.fn(async () => undefined);
    const client = {
      Browser: { getVersion: vi.fn(async () => ({})), close: browserClose },
      close: endpointClose,
    };
    const authority = await retainChromeEndpointAuthority(
      {
        host: "127.0.0.1",
        port: 64305,
        browserWSEndpoint,
        userDataDir: identity.profileDirectory.canonicalPath,
        processIdentity: identity,
      },
      {
        discoverEndpoint,
        connectBrowser: vi.fn(async () => client as never),
        inspectProcessIdentity: vi.fn(async () => "current" as const),
        resolveListeningOwner: vi.fn(async () => ({
          pid: identity.pid,
          processGeneration: listenerGeneration,
        })),
      },
    );

    const firstOperation = vi.fn(async () => "performed");
    await expect(authority.runExactOperation?.(firstOperation)).resolves.toEqual({
      status: "completed",
      value: "performed",
    });
    listenerGeneration = "linux:11111111-1111-4111-8111-111111111111:987655";
    const replacementOperation = vi.fn(async () => "must-not-run");
    await expect(authority.runExactOperation?.(replacementOperation)).resolves.toMatchObject({
      status: "unsafe",
      reason: expect.stringMatching(/exact Chrome process generation/i),
    });
    await expect(authority.kill()).resolves.toMatchObject({
      status: "unsafe",
      pid: identity.pid,
      reason: expect.stringMatching(/exact Chrome process generation/i),
    });
    expect(replacementOperation).not.toHaveBeenCalled();
    expect(browserClose).not.toHaveBeenCalled();
    await authority.release();
    expect(endpointClose).toHaveBeenCalledOnce();
  });

  test("blocks operations and kill after the DevTools endpoint rebinds on the same port", async () => {
    // Dynamic import keeps this endpoint assertion bound to Vitest's hoisted CDP mock.
    const { retainChromeEndpointAuthority } = await import("../../src/browser/chromeLifecycle.js");
    const baseIdentity = processIdentity(
      path.join(os.tmpdir(), "oracle-linux-endpoint-rebind-profile"),
      4321,
      "11111111-1111-4111-8111-111111111115",
    );
    const identity: ChromeProcessIdentity = {
      ...baseIdentity,
      processStartTime: "linux:11111111-1111-4111-8111-111111111111:987654",
      profileDirectory: { ...baseIdentity.profileDirectory, platform: "linux" },
    };
    const expectedEndpoint = "ws://127.0.0.1:64305/devtools/browser/exact-generation";
    let currentEndpoint = expectedEndpoint;
    const discoverEndpoint = vi.fn(async () => ({
      port: 64305,
      browserWSEndpoint: currentEndpoint,
    }));
    const browserClose = vi.fn(async () => undefined);
    const endpointClose = vi.fn(async () => undefined);
    const client = {
      Browser: { getVersion: vi.fn(async () => ({})), close: browserClose },
      close: endpointClose,
    };
    const authority = await retainChromeEndpointAuthority(
      {
        host: "127.0.0.1",
        port: 64305,
        browserWSEndpoint: expectedEndpoint,
        userDataDir: identity.profileDirectory.canonicalPath,
        processIdentity: identity,
      },
      {
        discoverEndpoint,
        connectBrowser: vi.fn(async () => client as never),
        inspectProcessIdentity: vi.fn(async () => "current" as const),
        resolveListeningOwner: vi.fn(async () => ({
          pid: identity.pid,
          processGeneration: identity.processStartTime,
        })),
      },
    );

    const firstOperation = vi.fn(async () => "performed");
    await expect(authority.runExactOperation?.(firstOperation)).resolves.toEqual({
      status: "completed",
      value: "performed",
    });
    currentEndpoint = "ws://127.0.0.1:64305/devtools/browser/replacement-generation";
    const replacementOperation = vi.fn(async () => "must-not-run");
    await expect(authority.runExactOperation?.(replacementOperation)).resolves.toMatchObject({
      status: "unsafe",
      reason: expect.stringMatching(/endpoint identity changed/i),
    });
    await expect(authority.kill()).resolves.toMatchObject({
      status: "unsafe",
      pid: identity.pid,
      reason: expect.stringMatching(/endpoint identity changed/i),
    });
    expect(replacementOperation).not.toHaveBeenCalled();
    expect(browserClose).not.toHaveBeenCalled();
    await authority.release();
    expect(endpointClose).toHaveBeenCalledOnce();
  });
});
