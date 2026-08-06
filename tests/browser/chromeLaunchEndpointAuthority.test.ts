import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { inspectChromeProcessIdentityForTest } from "../../src/browser/profileState.js";
import type { ChromeProcessIdentity } from "../../src/browser/profileState.js";
import type { ChromeProcessIdentityInspection } from "../../src/browser/chromeProcessIdentity.js";
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

  test("accepts a hidden Chrome endpoint only when macOS reports the exact listener pid", async () => {
    const { verifyListeningPortOwnedByProcessForTest } =
      await import("../../src/browser/chromeLifecycle.js");
    const exactOwner = vi.fn(async () => ({ stdout: "p4321\n" }));
    const differentOwner = vi.fn(async () => ({ stdout: "p9999\n" }));

    await expect(verifyListeningPortOwnedByProcessForTest(4321, 64305, exactOwner)).resolves.toBe(
      true,
    );
    await expect(
      verifyListeningPortOwnedByProcessForTest(4321, 64305, differentOwner),
    ).resolves.toBe(false);
  });

  test("blocks endpoint automation and close for a claimless possible Darwin PID recycle", async () => {
    // Dynamic import keeps this endpoint assertion bound to Vitest's hoisted CDP mock.
    const { retainChromeEndpointAuthority } = await import("../../src/browser/chromeLifecycle.js");
    const userDataDir = "/tmp/oracle-claimless-recycled-profile";
    const executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const identity: ChromeProcessIdentity = {
      pid: 4321,
      processStartTime: "darwin-sample-launch:2026-08-05T11:57:07.287-0400",
      executablePath,
      normalizedUserDataDir: userDataDir,
      launchNonce: "00000000-0000-4000-8000-000000007004",
      profileDirectory: {
        version: 1,
        platform: "darwin",
        canonicalPath: userDataDir,
        device: "1",
        inode: "2",
      },
    };
    const commandTokens = [
      executablePath,
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=64305",
    ];
    let observedStartTime = identity.processStartTime;
    const inspectProcessIdentity = vi.fn(
      async (profileDir: string, durableIdentity: ChromeProcessIdentity) =>
        inspectChromeProcessIdentityForTest(profileDir, durableIdentity, {
          platform: "darwin",
          verifyProfileIdentity: async () => true,
          isProcessAlive: () => true,
          readProcessSnapshot: async () => ({
            pid: identity.pid,
            processStartTime: observedStartTime,
            executablePath,
            commandLine: commandTokens.join(" "),
            commandTokens,
          }),
        }),
    );
    const browserClose = vi.fn(async () => undefined);
    const endpointClose = vi.fn(async () => undefined);
    const getProcessInfo = vi.fn(async () => ({
      processInfo: [{ id: identity.pid, type: "browser" }],
    }));
    const client = {
      Browser: { getVersion: vi.fn(async () => ({})), close: browserClose },
      SystemInfo: { getProcessInfo },
      close: endpointClose,
    };
    const authority = await retainChromeEndpointAuthority(
      {
        host: "127.0.0.1",
        port: 64305,
        browserWSEndpoint: "ws://127.0.0.1:64305/devtools/browser/claimless-recycled",
        userDataDir,
        processIdentity: identity,
      },
      {
        connectBrowser: vi.fn(async () => client as never),
        inspectProcessIdentity,
        resolveListeningPid: vi.fn(async () => identity.pid),
      },
    );

    observedStartTime = "darwin-audit-pidversion:7001";
    const operation = vi.fn(async () => "must-not-run");
    await expect(authority.runExactOperation?.(operation)).resolves.toMatchObject({
      status: "unsafe",
      reason: expect.stringMatching(/could not be reverified/i),
    });
    await expect(authority.kill()).resolves.toMatchObject({
      status: "unsafe",
      pid: identity.pid,
      reason: expect.stringMatching(/could not be reverified/i),
    });
    expect(operation).not.toHaveBeenCalled();
    expect(browserClose).not.toHaveBeenCalled();
    expect(getProcessInfo).toHaveBeenCalledOnce();
    await authority.release();
    expect(endpointClose).toHaveBeenCalledOnce();
  });

  test("binds a reusable endpoint to the exact browser process generation", async () => {
    // Dynamic import is required so Vitest's hoisted CDP mock initializes before module evaluation.
    const { retainChromeEndpointAuthority } = await import("../../src/browser/chromeLifecycle.js");
    const identity = processIdentity(
      path.join(os.tmpdir(), "oracle-reused-profile"),
      4321,
      "11111111-1111-4111-8111-111111111113",
    );
    const browserWSEndpoint = "ws://127.0.0.1:64305/devtools/browser/exact-generation";
    const discoverEndpoint = vi.fn(async () => ({ port: 64305, browserWSEndpoint }));
    const inspectProcessIdentity = vi.fn(
      async (): Promise<ChromeProcessIdentityInspection> => "current",
    );
    const resolveListeningPid = vi.fn(async () => identity.pid);
    const mismatchedClientClose = vi.fn(async () => undefined);
    const mismatchedClient = {
      Browser: { getVersion: vi.fn(async () => ({})) },
      SystemInfo: {
        getProcessInfo: vi.fn(async () => ({
          processInfo: [{ id: 9999, type: "browser" }],
        })),
      },
      close: mismatchedClientClose,
    };

    await expect(
      retainChromeEndpointAuthority(
        {
          host: "127.0.0.1",
          port: 64305,
          userDataDir: identity.profileDirectory.canonicalPath,
          processIdentity: identity,
        },
        {
          discoverEndpoint,
          connectBrowser: vi.fn(async () => mismatchedClient as never),
          inspectProcessIdentity,
          resolveListeningPid,
        },
      ),
    ).rejects.toThrow(/not bound to the captured browser process generation/i);
    expect(mismatchedClientClose).toHaveBeenCalledOnce();
    const failedValidationClose = vi.fn(async () => {
      throw new Error("validation client close failed");
    });
    await expect(
      retainChromeEndpointAuthority(
        {
          host: "127.0.0.1",
          port: 64305,
          userDataDir: identity.profileDirectory.canonicalPath,
          processIdentity: identity,
        },
        {
          discoverEndpoint,
          connectBrowser: vi.fn(
            async () => ({ ...mismatchedClient, close: failedValidationClose }) as never,
          ),
          inspectProcessIdentity,
          resolveListeningPid,
        },
      ),
    ).rejects.toThrow(/could not be validated or released safely/i);
    expect(failedValidationClose).toHaveBeenCalledOnce();

    const exactClientClose = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient endpoint release failure"))
      .mockResolvedValueOnce(undefined);
    const exactClient = {
      Browser: {
        getVersion: vi.fn(async () => ({})),
        close: vi.fn(async () => undefined),
      },
      SystemInfo: {
        getProcessInfo: vi.fn(async () => ({
          processInfo: [{ id: identity.pid, type: "browser" }],
        })),
      },
      close: exactClientClose,
    };
    const authority = await retainChromeEndpointAuthority(
      {
        host: "127.0.0.1",
        port: 64305,
        userDataDir: identity.profileDirectory.canonicalPath,
        processIdentity: identity,
      },
      {
        discoverEndpoint,
        connectBrowser: vi.fn(async () => exactClient as never),
        inspectProcessIdentity,
        resolveListeningPid,
      },
    );

    expect(authority.browserWSEndpoint).toBe(browserWSEndpoint);
    expect(inspectProcessIdentity).toHaveBeenCalledWith(
      identity.profileDirectory.canonicalPath,
      identity,
    );
    if (process.platform === "darwin") {
      expect(resolveListeningPid).toHaveBeenCalledWith(64305);
    }
    const exactOperation = vi.fn(async () => "performed");
    await expect(authority.runExactOperation?.(exactOperation)).resolves.toEqual({
      status: "completed",
      value: "performed",
    });
    expect(exactOperation).toHaveBeenCalledWith(exactClient);
    inspectProcessIdentity.mockResolvedValueOnce("exited");
    const replacementMutation = vi.fn(async () => "must-not-run");
    await expect(authority.runExactOperation?.(replacementMutation)).resolves.toEqual({
      status: "gone",
    });
    expect(replacementMutation).not.toHaveBeenCalled();
    await expect(authority.release()).rejects.toThrow(/transient endpoint release failure/i);
    await expect(authority.release()).resolves.toBeUndefined();
    await expect(authority.release()).resolves.toBeUndefined();
    expect(exactClientClose).toHaveBeenCalledTimes(2);
    await expect(authority.kill()).resolves.toMatchObject({
      status: "unsafe",
      pid: identity.pid,
      reason: expect.stringMatching(/already released/i),
    });
    expect(exactClient.Browser.close).not.toHaveBeenCalled();
  });
});
