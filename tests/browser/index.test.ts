import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import type * as ManualLoginProfileModule from "../../src/browser/manualLoginProfile.js";
import type * as TabLeaseRegistryModule from "../../src/browser/tabLeaseRegistry.js";
import type * as ChromeLifecycleModule from "../../src/browser/chromeLifecycle.js";
import type * as ProfileStateModule from "../../src/browser/profileState.js";
import type * as ProfileCopyModule from "../../src/browser/profileCopy.js";
import {
  __test__,
  classifyPreservedBrowserErrorForTest,
  formatBrowserTurnTranscript,
  isLocalChromeHostForTest,
  maybeArchiveCompletedConversationForTest,
  maybeArchiveInterruptedConversationForTest,
  redactBrowserConfigForDebugLogForTest,
  resolveRemoteTabLeaseProfileDirForTest,
  runBrowserMode,
  runSubmissionWithRecoveryForTest,
  shouldPreferSystemTmpDirForTest,
  shouldPreserveBrowserOnErrorForTest,
} from "../../src/browser/index.js";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import type { BrowserLogger } from "../../src/browser/types.js";
import { captureProfileDirectoryIdentity } from "../../src/browser/profileState.js";
import type {
  ChromeProcessIdentity,
  ChromeProcessLaunchClaim,
} from "../../src/browser/profileState.js";

describe("background-only browser policy", () => {
  test("rejects attach-running before browser discovery can touch the primary browser", async () => {
    await expect(
      runBrowserMode({ prompt: "review", config: { attachRunning: true } }),
    ).rejects.toMatchObject({ details: { stage: "background-browser-policy" } });
  });
});

describe("local acquisition durability", () => {
  test("releases a manual-login tab lease when post-acquisition persistence fails", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-local-acquisition-"));
    const persistenceFailure = new Error("runtime persistence failed");
    const events: string[] = [];
    const runtimeHints: BrowserRuntimeMetadata[] = [];
    const release = vi.fn(async () => {
      events.push("release:tab-lease");
    });
    const acquireBrowserTabLease = vi.fn(
      async (profileDirectory: string, options?: { leaseId?: string }) => {
        events.push("acquire:tab-lease");
        return {
          id: options?.leaseId ?? "test-lease",
          profileDirectory: await captureProfileDirectoryIdentity(profileDirectory),
          update: vi.fn(async () => undefined),
          release,
        };
      },
    );
    const releaseBrowserTabLease = vi.fn(
      async (
        _profileDirectory: string,
        _leaseId: string,
        _logger: BrowserLogger,
        options?: { onRelease?: (context: { isLastLease: boolean }) => Promise<void> },
      ) => {
        await release();
        await options?.onRelease?.({ isLastLease: true });
      },
    );
    let rejectedInitialProcessJournal = false;
    const runtimeHintCb = vi.fn(async (runtime: BrowserRuntimeMetadata) => {
      runtimeHints.push(structuredClone(runtime));
      const resource = runtime.recoveryCleanupResources?.at(-1);
      const mode = runtime.recoveryCleanupResult?.settlementMode;
      events.push(
        `persist:${resource?.acquisition?.pendingResource ?? "acquired"}${mode ? `:${mode}` : ""}`,
      );
      if (
        resource?.acquisition?.pendingResource === "chrome-process" &&
        !mode &&
        !rejectedInitialProcessJournal
      ) {
        rejectedInitialProcessJournal = true;
        throw persistenceFailure;
      }
    });

    vi.resetModules();
    vi.doMock("../../src/browser/tabLeaseRegistry.js", async (importOriginal) => ({
      ...(await importOriginal<typeof TabLeaseRegistryModule>()),
      acquireBrowserTabLease,
      releaseBrowserTabLease,
      retainBrowserTabLeaseTeardownAuthority: vi.fn(),
    }));
    vi.doMock("../../src/browser/profileState.js", async (importOriginal) => ({
      ...(await importOriginal<typeof ProfileStateModule>()),
      verifyProfileDirectoryIdentity: vi.fn(async () => true),
      readOracleChromeOwner: vi.fn(async () => null),
      inspectRunningChromeProcessesForLaunchClaim: vi.fn(async () => ({
        exactMatches: [],
        conflictingProfilePids: [],
      })),
    }));
    vi.doMock("../../src/browser/manualLoginProfile.js", async (importOriginal) => ({
      ...(await importOriginal<typeof ManualLoginProfileModule>()),
      assertManualLoginProfileReadyForRun: vi.fn(async () => undefined),
    }));

    try {
      // The production runner must load after this test's module mocks are installed.
      const { runBrowserMode: isolatedRunBrowserMode } = await import("../../src/browser/index.js");
      await expect(
        isolatedRunBrowserMode({
          prompt: "test",
          config: { manualLogin: true, manualLoginProfileDir: profileDir },
          runtimeHintCb,
        }),
      ).rejects.toBe(persistenceFailure);

      expect(events).toEqual([
        "persist:tab-lease",
        "acquire:tab-lease",
        "persist:chrome-process",
        "persist:chrome-process:abort",
        "release:tab-lease",
        "persist:acquired",
      ]);
      const initialResource = runtimeHints[0]?.recoveryCleanupResources?.at(-1);
      const abortRuntime = runtimeHints.find(
        (runtime) => runtime.recoveryCleanupResult?.settlementMode === "abort",
      );
      const abortResource = abortRuntime?.recoveryCleanupResources?.at(-1);
      const acquisitionGenerationId = initialResource?.acquisition?.generationId;
      if (!acquisitionGenerationId || !abortRuntime || !abortResource) {
        throw new Error("Manual-login acquisition abort authority was not journaled");
      }
      expect(abortResource.acquisition).toMatchObject({
        generationId: acquisitionGenerationId,
        pendingResource: "chrome-process",
        processLaunchClaim: { generationId: acquisitionGenerationId },
      });
      expect(abortRuntime.recoveryCleanupResult).toMatchObject({
        status: "failed",
        settlementMode: "abort",
      });
      expect(runtimeHints.at(-1)?.recoveryCleanupResources).toBeUndefined();
      expect(runtimeHints.at(-1)?.recoveryCleanupResult).toBeUndefined();
      expect(release).toHaveBeenCalledOnce();
      expect(releaseBrowserTabLease).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("../../src/browser/tabLeaseRegistry.js");
      vi.doUnmock("../../src/browser/profileState.js");
      vi.doUnmock("../../src/browser/manualLoginProfile.js");
      vi.resetModules();
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("removes the exact temporary profile when profile copy fails after journaling", async () => {
    const copyFailure = new Error("profile copy interrupted");
    const runtimeHints: BrowserRuntimeMetadata[] = [];
    const events: string[] = [];
    let profileDir: string | undefined;
    const removeProfile = vi.fn(async () => true);
    const launchChrome = vi.fn();
    const copyChromeProfile = vi.fn(async (_source: string, destination: string) => {
      profileDir = destination;
      events.push("copy-profile");
      throw copyFailure;
    });

    vi.resetModules();
    vi.doMock("../../src/browser/profileCopy.js", async (importOriginal) => ({
      ...(await importOriginal<typeof ProfileCopyModule>()),
      copyChromeProfile,
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", async (importOriginal) => ({
      ...(await importOriginal<typeof ChromeLifecycleModule>()),
      launchChrome,
    }));
    vi.doMock("../../src/browser/profileState.js", async (importOriginal) => ({
      ...(await importOriginal<typeof ProfileStateModule>()),
      verifyProfileDirectoryIdentity: vi.fn(async () => true),
      readOracleChromeOwner: vi.fn(async () => null),
      inspectRunningChromeProcessesForLaunchClaim: vi.fn(async () => ({
        exactMatches: [],
        conflictingProfilePids: [],
      })),
      removeProfileDirectoryIfIdentityMatches: removeProfile,
    }));

    try {
      // This test intentionally reloads the runner so the profile-copy failure is injected.
      const { runBrowserMode: isolatedRunBrowserMode } = await import("../../src/browser/index.js");
      await expect(
        isolatedRunBrowserMode({
          prompt: "test",
          config: {
            cookieSync: false,
            manualLogin: false,
            copyProfileSource: path.join(os.tmpdir(), "oracle-copy-profile-source"),
          },
          runtimeHintCb: async (runtime) => {
            runtimeHints.push(structuredClone(runtime));
            const resource = runtime.recoveryCleanupResources?.at(-1);
            const mode = runtime.recoveryCleanupResult?.settlementMode;
            events.push(
              `persist:${resource?.acquisition?.pendingResource ?? "acquired"}${mode ? `:${mode}` : ""}`,
            );
          },
        }),
      ).rejects.toBe(copyFailure);

      expect(events).toEqual([
        "persist:chrome-process",
        "copy-profile",
        "persist:chrome-process:abort",
        "persist:acquired",
      ]);
      const initialRuntime = runtimeHints[0];
      const initialResource = initialRuntime?.recoveryCleanupResources?.at(-1);
      expect(initialResource).toMatchObject({
        acquisition: { pendingResource: "chrome-process" },
        recoveryCleanup: { profileKind: "copied", keepBrowser: false },
      });
      const abortRuntime = runtimeHints.find(
        (runtime) => runtime.recoveryCleanupResult?.settlementMode === "abort",
      );
      const abortResource = abortRuntime?.recoveryCleanupResources?.at(-1);
      const acquisitionGenerationId = initialResource?.acquisition?.generationId;
      if (!acquisitionGenerationId || !abortRuntime || !abortResource) {
        throw new Error("Copy-profile acquisition abort authority was not journaled");
      }
      expect(abortResource.acquisition).toMatchObject({
        generationId: acquisitionGenerationId,
        pendingResource: "chrome-process",
        processLaunchClaim: { generationId: acquisitionGenerationId },
      });
      expect(abortRuntime.recoveryCleanupResult).toMatchObject({
        status: "failed",
        settlementMode: "abort",
      });
      expect(launchChrome).not.toHaveBeenCalled();
      expect(runtimeHints.at(-1)?.recoveryCleanupResources).toBeUndefined();
      expect(runtimeHints.at(-1)?.recoveryCleanupResult).toBeUndefined();
      if (!profileDir || !initialResource?.profileDirectoryIdentity) {
        throw new Error("Copy-profile acquisition identity was not journaled");
      }
      expect(removeProfile).toHaveBeenCalledWith(
        profileDir,
        initialResource.profileDirectoryIdentity,
      );
    } finally {
      vi.doUnmock("../../src/browser/profileCopy.js");
      vi.doUnmock("../../src/browser/chromeLifecycle.js");
      vi.doUnmock("../../src/browser/profileState.js");
      vi.resetModules();
      if (profileDir) await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("persists abort authority before cleaning an owner whose target journal fails", async () => {
    const journalFailure = new Error("target acquisition journal failed");
    const runtimeHints: BrowserRuntimeMetadata[] = [];
    const events: string[] = [];
    let profileDir: string | undefined;
    let ownerIdentity: ChromeProcessIdentity | undefined;
    let rejectedTargetJournal = false;
    const kill = vi.fn(async () => ({
      status: "stopped" as const,
      pid: 515_151,
      signal: "CONTROL_CHANNEL" as const,
    }));
    const removeProfile = vi.fn(async () => true);

    vi.resetModules();
    vi.doMock("../../src/browser/chromeLifecycle.js", async (importOriginal) => ({
      ...(await importOriginal<typeof ChromeLifecycleModule>()),
      launchChrome: vi.fn(
        async (
          _config: unknown,
          userDataDir: string,
          _logger: BrowserLogger,
          deps?: { launchClaim?: ChromeProcessLaunchClaim },
        ) => {
          profileDir = userDataDir;
          const launchClaim = deps?.launchClaim;
          if (!launchClaim) throw new Error("launch claim was not supplied");
          const profileDirectory = await captureProfileDirectoryIdentity(userDataDir);
          ownerIdentity = {
            pid: 515_151,
            processStartTime: "published-owner-generation",
            executablePath:
              process.platform === "win32"
                ? String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`.toLowerCase()
                : process.platform === "darwin"
                  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                  : "/usr/bin/google-chrome",
            normalizedUserDataDir:
              process.platform === "win32"
                ? profileDirectory.canonicalPath.toLowerCase()
                : profileDirectory.canonicalPath,
            launchNonce: launchClaim.nonce,
            launchClaim,
            profileDirectory,
          };
          return {
            pid: ownerIdentity.pid,
            port: 9222,
            process: undefined,
            remoteDebuggingPipes: null,
            host: "127.0.0.1",
            kill,
            processIdentity: ownerIdentity,
          };
        },
      ),
    }));
    vi.doMock("../../src/browser/profileState.js", async (importOriginal) => ({
      ...(await importOriginal<typeof ProfileStateModule>()),
      removeProfileDirectoryIfIdentityMatches: removeProfile,
    }));

    try {
      // This test intentionally reloads the runner so the post-owner journal can fail.
      const { runBrowserMode: isolatedRunBrowserMode } = await import("../../src/browser/index.js");
      await expect(
        isolatedRunBrowserMode({
          prompt: "test",
          config: { cookieSync: false, manualLogin: false },
          runtimeHintCb: async (runtime) => {
            runtimeHints.push(structuredClone(runtime));
            const resource = runtime.recoveryCleanupResources?.at(-1);
            const mode = runtime.recoveryCleanupResult?.settlementMode;
            events.push(
              `persist:${resource?.acquisition?.pendingResource ?? "acquired"}${mode ? `:${mode}` : ""}`,
            );
            if (
              resource?.acquisition?.pendingResource === "chrome-target" &&
              !mode &&
              !rejectedTargetJournal
            ) {
              rejectedTargetJournal = true;
              throw journalFailure;
            }
          },
        }),
      ).rejects.toBe(journalFailure);

      expect(events).toEqual([
        "persist:chrome-process",
        "persist:chrome-target",
        "persist:chrome-process:abort",
        "persist:acquired",
      ]);
      const abortRuntime = runtimeHints.find(
        (runtime) => runtime.recoveryCleanupResult?.settlementMode === "abort",
      );
      expect(abortRuntime?.recoveryCleanupResources?.at(-1)).toMatchObject({
        chromeProcessIdentity: ownerIdentity,
        acquisition: { pendingResource: "chrome-process" },
        recoveryCleanup: { ownsTarget: false, keepBrowser: false },
      });
      expect(kill).toHaveBeenCalledOnce();
      if (!profileDir || !ownerIdentity)
        throw new Error("Published owner authority was not captured");
      expect(removeProfile).toHaveBeenCalledWith(profileDir, ownerIdentity.profileDirectory);
      expect(runtimeHints.at(-1)?.recoveryCleanupResources).toBeUndefined();
    } finally {
      vi.doUnmock("../../src/browser/chromeLifecycle.js");
      vi.doUnmock("../../src/browser/profileState.js");
      vi.resetModules();
      if (profileDir) await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("recovers one exact temporary Chrome generation after a crash before owner publication", async () => {
    const interruption = new Error("controller interrupted after Chrome launch");
    const runtimeHints: BrowserRuntimeMetadata[] = [];
    let profileDir: string | undefined;
    let ownerIdentity: ChromeProcessIdentity | undefined;
    let launchClaim: ChromeProcessLaunchClaim | undefined;
    const endpointKill = vi.fn(async () => ({
      status: "stopped" as const,
      pid: 424_242,
      signal: "CONTROL_CHANNEL" as const,
    }));
    const releaseEndpointAuthority = vi.fn(async () => undefined);
    const retainedEndpointAuthority = {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/recovered-launch",
      kill: endpointKill,
      release: releaseEndpointAuthority,
    };
    const retainChromeEndpointAuthority = vi.fn(async () => retainedEndpointAuthority);
    const writeOracleChromeOwner = vi.fn(async () => undefined);
    const removeProfile = vi.fn(async () => true);

    vi.resetModules();
    vi.doMock("../../src/browser/chromeLifecycle.js", async (importOriginal) => ({
      ...(await importOriginal<typeof ChromeLifecycleModule>()),
      retainChromeEndpointAuthority,
      launchChrome: vi.fn(
        async (
          _config: unknown,
          userDataDir: string,
          _logger: BrowserLogger,
          deps?: { launchClaim?: ChromeProcessLaunchClaim },
        ) => {
          profileDir = userDataDir;
          launchClaim = deps?.launchClaim;
          if (!launchClaim) throw new Error("launch claim was not supplied");
          const profileDirectory = await captureProfileDirectoryIdentity(userDataDir);
          ownerIdentity = {
            pid: 424_242,
            processStartTime: "test-process-generation",
            executablePath:
              process.platform === "win32"
                ? String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`.toLowerCase()
                : process.platform === "darwin"
                  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                  : "/usr/bin/google-chrome",
            normalizedUserDataDir:
              process.platform === "win32"
                ? profileDirectory.canonicalPath.toLowerCase()
                : profileDirectory.canonicalPath,
            launchNonce: launchClaim.nonce,
            launchClaim,
            profileDirectory,
          };
          throw interruption;
        },
      ),
    }));
    vi.doMock("../../src/browser/profileState.js", async (importOriginal) => ({
      ...(await importOriginal<typeof ProfileStateModule>()),
      verifyProfileDirectoryIdentity: vi.fn(async () => true),
      readOracleChromeOwner: vi.fn(async () => null),
      inspectRunningChromeProcessesForLaunchClaim: vi.fn(
        async (_candidateDir: string, claim: ChromeProcessLaunchClaim) => {
          expect(claim).toEqual(launchClaim);
          return {
            exactMatches: [{ pid: 424_242, port: 9222 }],
            conflictingProfilePids: [],
          };
        },
      ),
      captureChromeProcessIdentity: vi.fn(
        async (candidateDir: string, pid: number, claim: ChromeProcessLaunchClaim) => {
          expect(candidateDir).toBe(profileDir);
          expect(pid).toBe(424_242);
          expect(claim).toEqual(launchClaim);
          if (!ownerIdentity) throw new Error("launched Chrome identity was not captured");
          return ownerIdentity;
        },
      ),
      inspectChromeProcessIdentity: vi.fn(async () => "current" as const),
      writeOracleChromeOwner,
      verifyChromeProcessIdentity: vi.fn(async () => true),
      removeProfileDirectoryIfIdentityMatches: removeProfile,
    }));

    try {
      // This test intentionally loads the runner after installing its module mocks.
      const { runBrowserMode: isolatedRunBrowserMode } = await import("../../src/browser/index.js");
      await expect(
        isolatedRunBrowserMode({
          prompt: "test",
          config: { cookieSync: false, manualLogin: false },
          runtimeHintCb: async (runtime) => {
            runtimeHints.push(structuredClone(runtime));
          },
        }),
      ).rejects.toBe(interruption);

      const initialRuntime = runtimeHints.find(
        (runtime) =>
          runtime.recoveryCleanupResources?.at(-1)?.acquisition?.pendingResource ===
            "chrome-process" && !runtime.recoveryCleanupResult?.settlementMode,
      );
      const abortRuntime = runtimeHints.find(
        (runtime) =>
          runtime.recoveryCleanupResources?.at(-1)?.acquisition?.pendingResource ===
            "chrome-process" && runtime.recoveryCleanupResult?.settlementMode === "abort",
      );
      const completedRuntime = runtimeHints.at(-1);
      if (!initialRuntime || !abortRuntime || !completedRuntime) {
        throw new Error("Chrome acquisition transaction journal was incomplete");
      }
      const initialResource = initialRuntime.recoveryCleanupResources?.at(-1);
      const abortResource = abortRuntime.recoveryCleanupResources?.at(-1);
      const acquisitionGenerationId = initialResource?.acquisition?.generationId;
      if (!acquisitionGenerationId || !abortResource) {
        throw new Error("Recovered Chrome acquisition generation authority was not journaled");
      }
      expect(initialResource).toMatchObject({
        acquisition: {
          generationId: acquisitionGenerationId,
          pendingResource: "chrome-process",
          processOwnerProvenance: "temporary-launch",
          processLaunchClaim: launchClaim,
          processOwnerDisposition: "close-on-last-lease",
        },
        recoveryCleanup: { keepBrowser: false },
      });
      expect(abortResource.acquisition).toMatchObject({
        generationId: acquisitionGenerationId,
        pendingResource: "chrome-process",
        processLaunchClaim: launchClaim,
      });
      expect(
        initialRuntime.recoveryCleanupResources?.at(-1)?.chromeProcessIdentity,
      ).toBeUndefined();
      expect(abortRuntime.recoveryCleanupResult).toMatchObject({
        status: "failed",
        settlementMode: "abort",
      });
      if (!profileDir || !ownerIdentity) {
        throw new Error("launched Chrome test authority was not captured");
      }

      expect(writeOracleChromeOwner).toHaveBeenCalledWith(profileDir, {
        port: 9222,
        processIdentity: ownerIdentity,
        disposition: "close-on-last-lease",
      });
      expect(retainChromeEndpointAuthority).toHaveBeenCalledTimes(2);
      expect(endpointKill).toHaveBeenCalledOnce();
      expect(releaseEndpointAuthority).toHaveBeenCalledTimes(2);
      expect(completedRuntime.recoveryCleanupResources).toBeUndefined();
      expect(completedRuntime.recoveryCleanupResult).toBeUndefined();
      expect(removeProfile).toHaveBeenCalledWith(profileDir, ownerIdentity.profileDirectory);
    } finally {
      vi.doUnmock("../../src/browser/chromeLifecycle.js");
      vi.doUnmock("../../src/browser/profileState.js");
      vi.resetModules();
      if (profileDir) await rm(profileDir, { recursive: true, force: true });
    }
  });
});

describe("unpublished browser cleanup", () => {
  test("escapes with retryable runtime and preserves the browser failure as cause", () => {
    const originalFailure = new Error("assistant capture failed");
    const runtime = {
      recoveryCleanupResources: [
        {
          userDataDir: "/tmp/copied-profile",
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "copied" as const,
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
      recoveryCleanupResult: {
        status: "failed" as const,
        error: "profile removal was not confirmed",
        settlementMode: "finalize" as const,
      },
    };

    const error = __test__.unpublishedCleanupPendingError(
      {
        status: "pending",
        runtime,
        error: "profile removal was not confirmed",
      },
      originalFailure,
    );

    expect(error).toMatchObject({
      details: {
        stage: "browser-capture-finalization",
        code: "unpublished-cleanup-pending",
        runtime,
        cleanupError: "profile removal was not confirmed",
      },
    });
    expect((error as Error & { cause?: unknown }).cause).toBe(originalFailure);
  });
});

describe("shouldPreserveBrowserOnErrorForTest", () => {
  test("preserves the browser for headful cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
  });

  test("does not preserve the browser for headless cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, true)).toBe(false);
  });

  test("preserves the browser for headful assistant capture errors", () => {
    const timeout = new BrowserAutomationError("assistant timed out", {
      stage: "assistant-timeout",
    });
    const recheck = new BrowserAutomationError("assistant recheck failed", {
      stage: "assistant-recheck",
    });

    expect(shouldPreserveBrowserOnErrorForTest(timeout, false)).toBe(true);
    expect(shouldPreserveBrowserOnErrorForTest(recheck, false)).toBe(true);
    expect(classifyPreservedBrowserErrorForTest(timeout, false)).toBe("reattachable-capture");
    expect(classifyPreservedBrowserErrorForTest(recheck, false)).toBe("reattachable-capture");
  });

  test("does not preserve assistant capture errors in headless mode", () => {
    const error = new BrowserAutomationError("assistant timed out", {
      stage: "assistant-timeout",
    });

    expect(shouldPreserveBrowserOnErrorForTest(error, true)).toBe(false);
    expect(classifyPreservedBrowserErrorForTest(error, true)).toBeNull();
  });

  test("does not preserve the browser for unrelated browser errors", () => {
    const error = new BrowserAutomationError("other browser error", {
      stage: "execute-browser",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(false);
    expect(classifyPreservedBrowserErrorForTest(error, false)).toBeNull();
  });

  test("classifies Cloudflare preservation separately from assistant capture preservation", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });

    expect(classifyPreservedBrowserErrorForTest(error, false)).toBe("cloudflare-challenge");
  });
});

describe("recoverable disconnect policy", () => {
  test("never retains a copied profile after a preserved browser error", () => {
    expect(
      __test__.shouldKeepLocalBrowserOpen({
        effectiveKeepBrowser: false,
        preserveBrowserOnError: true,
        usingCopiedProfile: true,
      }),
    ).toBe(false);
  });

  test("keeps existing retention semantics for ordinary profiles", () => {
    expect(
      __test__.shouldKeepLocalBrowserOpen({
        effectiveKeepBrowser: false,
        preserveBrowserOnError: true,
        usingCopiedProfile: false,
      }),
    ).toBe(true);
  });

  test.each([
    ["close-on-last-lease", false],
    ["preserve", true],
  ] as const)(
    "preserves manual-login owners according to their %s disposition",
    (ownerDisposition, expected) => {
      expect(
        __test__.shouldPreserveLocalOwnerForRecovery({
          effectiveKeepBrowser: false,
          manualLogin: true,
          ownerDisposition,
        }),
      ).toBe(expected);
    },
  );

  test("keeps the completed conversation tab when keepBrowser is enabled", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: true,
        keepBrowser: true,
      }),
    ).toBe(false);
  });

  test("closes owned completed tabs by default", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: true,
        keepBrowser: false,
      }),
    ).toBe(true);
  });

  test("closes a completed service-owned tab while keeping shared Chrome alive", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: true,
        keepBrowser: true,
        closeOwnedTabOnComplete: true,
      }),
    ).toBe(true);
  });

  test("does not close attached targets", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: false,
        keepBrowser: false,
        closeOwnedTabOnComplete: true,
      }),
    ).toBe(false);
  });

  test("closes owned incomplete targets by default", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "attempted",
        ownsTarget: true,
        keepBrowser: false,
        closeOwnedTabOnComplete: true,
      }),
    ).toBe(true);
  });

  test("keeps owned incomplete targets only for explicit recovery", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "attempted",
        ownsTarget: true,
        keepBrowser: false,
        closeOwnedTabOnComplete: true,
        preserveForRecovery: true,
      }),
    ).toBe(false);
  });

  test("schedules final blank cleanup for retained manual-login Chrome", () => {
    expect(
      __test__.shouldCleanupBlankTabsAfterLastLease({
        runStatus: "complete",
        ownsTarget: true,
        connectionClosedUnexpectedly: false,
        manualLogin: true,
        keepBrowser: true,
        chromePort: 9222,
      }),
    ).toBe(true);
    expect(
      __test__.shouldCleanupBlankTabsAfterLastLease({
        runStatus: "complete",
        ownsTarget: true,
        connectionClosedUnexpectedly: false,
        manualLogin: true,
        keepBrowser: false,
        chromePort: 9222,
      }),
    ).toBe(false);
    expect(
      __test__.shouldCleanupBlankTabsAfterLastLease({
        runStatus: "attempted",
        ownsTarget: true,
        connectionClosedUnexpectedly: false,
        manualLogin: true,
        keepBrowser: true,
        chromePort: 9222,
      }),
    ).toBe(false);
    expect(
      __test__.shouldCleanupBlankTabsAfterLastLease({
        runStatus: "complete",
        ownsTarget: false,
        connectionClosedUnexpectedly: false,
        manualLogin: true,
        keepBrowser: true,
        chromePort: 9222,
      }),
    ).toBe(false);
    expect(
      __test__.shouldCleanupBlankTabsAfterLastLease({
        runStatus: "complete",
        ownsTarget: true,
        connectionClosedUnexpectedly: true,
        manualLogin: true,
        keepBrowser: true,
        chromePort: 9222,
      }),
    ).toBe(false);
  });
});

describe("authenticated model-selection errors", () => {
  test("preserves picker diagnostics without adding cookie guidance", () => {
    const error = new BrowserAutomationError(
      'Unable to find model option matching "GPT-5.2 Instant". Available: GPT-5.6 Sol.',
      { stage: "model-selection" },
    );

    const normalized = __test__.normalizeAuthenticatedModelSelectionError(error);

    expect(normalized).toBe(error);
    expect(normalized.message).toContain("Available: GPT-5.6 Sol");
    expect(normalized.message).not.toMatch(/cookies|log in/i);
  });
});

describe("attachment upload timeout policy", () => {
  const attachment = (sizeBytes?: number) => ({
    path: "/tmp/attachment",
    displayPath: "attachment",
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  });

  test("adds size budget for a roughly 24 MB attachment", () => {
    expect(__test__.resolveAttachmentUploadTimeoutMs([attachment(24.4 * 1024 * 1024)])).toBe(
      95_000,
    );
  });

  test("keeps the existing conservative budget for unknown sizes", () => {
    expect(__test__.resolveAttachmentUploadTimeoutMs([attachment()])).toBe(45_000);
  });

  test("adds budget for multiple attachments", () => {
    expect(__test__.resolveAttachmentUploadTimeoutMs([attachment(), attachment()])).toBe(65_000);
  });

  test("uses inputTimeoutMs as a floor", () => {
    expect(__test__.resolveAttachmentUploadTimeoutMs([attachment()], 60_000)).toBe(60_000);
  });

  test("caps automatic scaling for very large attachments", () => {
    expect(__test__.resolveAttachmentUploadTimeoutMs([attachment(100 * 1024 * 1024)])).toBe(
      180_000,
    );
  });

  test("preserves an explicit inputTimeoutMs above the automatic cap", () => {
    expect(__test__.resolveAttachmentUploadTimeoutMs([attachment()], 300_000)).toBe(300_000);
  });
});

describe("manual-login profile setup gate", () => {
  test("fails fast for an uninitialized manual-login profile unless setup keeps Chrome open", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-empty-profile-"));
    try {
      await expect(
        __test__.assertManualLoginProfileReadyForRun({
          userDataDir: dir,
          keepBrowser: false,
        }),
      ).rejects.toThrow(/private Chrome profile/i);

      await expect(
        __test__.assertManualLoginProfileReadyForRun({
          userDataDir: dir,
          keepBrowser: true,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("accepts an initialized manual-login Chrome profile", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-initialized-profile-"));
    try {
      await mkdir(path.join(dir, "Default"));
      await expect(
        __test__.assertManualLoginProfileReadyForRun({
          userDataDir: dir,
          keepBrowser: false,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("formats the first-time setup command with the selected profile", () => {
    expect(__test__.formatManualLoginSetupCommand("/tmp/oracle profile")).toContain(
      '--browser-manual-login-profile-dir "/tmp/oracle profile"',
    );
  });

  test("caps non-setup manual-login waits so MCP callers fail fast", () => {
    expect(__test__.resolveManualLoginWaitMs(20 * 60_000, false)).toBe(30_000);
    expect(__test__.resolveManualLoginWaitMs(5_000, false)).toBe(5_000);
    expect(__test__.resolveManualLoginWaitMs(20 * 60_000, true)).toBe(20 * 60_000);
  });
});

// NOTE: shouldSkipThinkingTimeSelection was removed — it incorrectly assumed
// that selecting "Pro" in the picker always implied Extended effort, which is
// wrong for lower-tier plans where Pro defaults to Standard. The thinking time
// step now always runs; ensureThinkingTime handles the already-selected case.

describe("formatBrowserTurnTranscript", () => {
  test("keeps single-turn browser output unchanged", () => {
    expect(
      formatBrowserTurnTranscript([
        {
          label: "Initial response",
          answerText: "plain answer",
          answerMarkdown: "**plain answer**",
        },
      ]),
    ).toEqual({
      answerText: "plain answer",
      answerMarkdown: "**plain answer**",
    });
  });

  test("formats multi-turn consult output with follow-up prompts", () => {
    const result = formatBrowserTurnTranscript([
      {
        label: "Initial response",
        answerText: "initial answer",
        answerMarkdown: "initial answer",
      },
      {
        label: "Follow-up 1",
        prompt: "Challenge your previous recommendation.",
        answerText: "revised answer",
        answerMarkdown: "revised answer",
      },
    ]);

    expect(result.answerMarkdown).toContain("## Initial response");
    expect(result.answerMarkdown).toContain("## Follow-up 1");
    expect(result.answerMarkdown).toContain(
      "### Prompt\n\nChallenge your previous recommendation.",
    );
    expect(result.answerMarkdown).toContain("### Answer\n\nrevised answer");
    expect(result.answerText).toBe(result.answerMarkdown);
  });
});

describe("ChatGPT UI warning detection", () => {
  test("classifies request-speed warnings as rate limits", () => {
    expect(
      __test__.classifyChatGptUiWarningText(
        "You are sending too many requests too quickly. Please try again later.",
      ),
    ).toBe("rate_limit");
  });

  test("classifies visually mangled request-speed modal text as rate limits", () => {
    expect(
      __test__.classifyChatGptUiWarningText(
        "Too many reque t. You’re making reque t too quickly. We’ve temporarily limited access to your conversations. Please wait a few minutes before trying again.",
      ),
    ).toBe("rate_limit");
  });

  test("classifies bare retry-later warnings as temporary unavailability", () => {
    expect(__test__.classifyChatGptUiWarningText("Try again later.")).toBe("temporary_unavailable");
  });

  test("collects visible warning candidates from the browser DOM", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              text: "You are sending too many requests too quickly. Please try again later.",
              source: "selector",
              role: "alert",
              ariaLive: "assertive",
              selector: '[role="alert"]',
            },
            {
              text: "ordinary page text",
              source: "visible-warning-text",
            },
          ],
        },
      }),
    };

    await expect(__test__.collectChatGptUiWarnings(Runtime as never)).resolves.toEqual([
      {
        type: "rate_limit",
        message: "You are sending too many requests too quickly. Please try again later.",
        source: "selector",
        role: "alert",
        ariaLive: "assertive",
        selector: '[role="alert"]',
      },
    ]);
    const expression = Runtime.evaluate.mock.calls[0]?.[0]?.expression;
    expect(expression).not.toContain("createTreeWalker");
    expect(expression).not.toContain('[class*="error" i]');
    expect(expression).not.toContain('[class*="warning" i]');
    expect(expression).toContain("current = current.parentElement");
    expect(expression).toContain("Number.parseFloat(currentStyle.opacity || '1') === 0");
  });

  test("redacts account and token-like values from warning details", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              text: "Sign in as private@example.test with session_token=secret-session-value",
              source: "selector",
              role: "dialog",
              selector: '[role="dialog"]',
            },
          ],
        },
      }),
    };

    const warnings = await __test__.collectChatGptUiWarnings(Runtime as never);
    expect(warnings).toEqual([
      {
        type: "auth_or_challenge",
        message: "Sign in as [redacted-email] with session_token=[redacted]",
        source: "selector",
        role: "dialog",
        ariaLive: null,
        selector: '[role="dialog"]',
      },
    ]);
    expect(JSON.stringify(warnings)).not.toContain("private@example.test");
    expect(JSON.stringify(warnings)).not.toContain("secret-session-value");
  });

  test("builds a structured timeout error when ChatGPT shows a blocking warning", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              text: "You are sending too many requests too quickly. Please try again later.",
              source: "selector",
              role: "alert",
              ariaLive: "assertive",
              selector: '[role="alert"]',
            },
          ],
        },
      }),
    };
    const logger = vi.fn<(message: string) => void>();

    const error = await __test__.createAssistantTimeoutError({
      Runtime: Runtime as never,
      logger: logger as never,
      runtime: { chromePort: 9222 },
      diagnostics: { domPath: "/tmp/assistant-timeout.dom.json" },
      cause: new Error("timeout"),
    });

    expect(error.message).toContain("rate-limit warning");
    expect(error.details).toMatchObject({
      stage: "assistant-timeout",
      code: "chatgpt-ui-warning",
      runtime: { chromePort: 9222 },
      diagnostics: { domPath: "/tmp/assistant-timeout.dom.json" },
      uiWarning: {
        type: "rate_limit",
        message: "You are sending too many requests too quickly. Please try again later.",
      },
    });
    expect(logger).toHaveBeenCalledWith(
      "[browser] ChatGPT UI warning detected (rate_limit): You are sending too many requests too quickly. Please try again later.",
    );
  });

  test("keeps the generic timeout error when no blocking warning is visible", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: [] } }),
    };

    const error = await __test__.createAssistantTimeoutError({
      Runtime: Runtime as never,
      logger: vi.fn() as never,
      runtime: { chromePort: 9222 },
      cause: new Error("timeout"),
    });

    expect(error.message).toBe(
      "Assistant response timed out before completion; reattach later to capture the answer.",
    );
    expect(error.details).toMatchObject({
      stage: "assistant-timeout",
      runtime: { chromePort: 9222 },
    });
    expect(error.details).not.toHaveProperty("uiWarning");
  });

  test("routes plain response observer timeouts through assistant timeout handling", () => {
    expect(__test__.isAssistantResponseTimeoutError(new Error("Response timeout"))).toBe(true);
    expect(__test__.isAssistantResponseTimeoutError(new Error("Navigation timeout"))).toBe(false);
  });

  test("waits for prior turns to hydrate before retrying capture after a stall reload", async () => {
    vi.useFakeTimers();
    try {
      let reloaded = false;
      let hydrated = false;
      const responseProbeHydrationStates: boolean[] = [];
      const partial = { text: "Synthetic preamble.", messageId: "mid", turnId: "tid" };
      const complete = {
        text: "Synthetic complete answer after safe reload.",
        messageId: "mid",
        turnId: "tid",
      };
      const Runtime = {
        evaluate: vi.fn(async (params: { expression?: string; awaitPromise?: boolean }) => {
          const expression = String(params.expression ?? "");
          if (expression === "location.href") {
            return { result: { value: "https://chatgpt.com/c/synthetic-recovery" } };
          }
          if (expression.startsWith("document.querySelectorAll(")) {
            return { result: { value: hydrated ? 2 : 0 } };
          }
          if (expression.includes("const selectors =")) {
            return { result: { value: true } };
          }
          if (params.awaitPromise) {
            responseProbeHydrationStates.push(hydrated);
            if (!reloaded) {
              return new Promise(() => undefined);
            }
            return { result: { type: "object", value: complete } };
          }
          if (expression.includes("extractAssistantTurn")) {
            return { result: { value: reloaded ? complete : partial } };
          }
          if (expression.includes("Find the LAST assistant turn")) {
            return { result: { value: reloaded } };
          }
          return { result: { value: false } };
        }),
        terminateExecution: vi.fn().mockResolvedValue(undefined),
      };
      const Page = {
        navigate: vi.fn(async () => {
          reloaded = true;
          setTimeout(() => {
            hydrated = true;
          }, 250);
          return {};
        }),
      };

      const promise = __test__.waitForAssistantResponseWithReload(
        Runtime as never,
        Page as never,
        3_000,
        vi.fn() as never,
        undefined,
        "synthetic-recovery",
      );
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(promise).resolves.toMatchObject({ text: complete.text });
      expect(Page.navigate).toHaveBeenCalledOnce();
      expect(responseProbeHydrationStates).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("browser follow-ups", () => {
  test("rejects copy-profile with manual-login before launching Chrome", async () => {
    await expect(
      runBrowserMode({
        prompt: "test",
        config: {
          manualLogin: true,
          copyProfileSource: "/tmp/source-profile",
        },
      }),
    ).rejects.toThrow(/cannot be combined.*browser-manual-login/i);
  });

  test("rejects copy-profile with existing-browser modes before connecting", async () => {
    await expect(
      runBrowserMode({
        prompt: "test",
        config: {
          attachRunning: true,
          copyProfileSource: "/tmp/source-profile",
        },
      }),
    ).rejects.toThrow(/cannot be combined.*remote Chrome/i);
    await expect(
      runBrowserMode({
        prompt: "test",
        config: {
          remoteChrome: { host: "127.0.0.1", port: 9222 },
          copyProfileSource: "/tmp/source-profile",
        },
      }),
    ).rejects.toThrow(/cannot be combined.*remote Chrome/i);
  });

  test("rejects Deep Research follow-ups before launching Chrome", async () => {
    await expect(
      runBrowserMode({
        prompt: "research this",
        followUpPrompts: ["now challenge the report"],
        config: { researchMode: "deep" },
      }),
    ).rejects.toThrow(/follow-ups are not supported with Deep Research/i);
  });
});

describe("browser conversation archiving", () => {
  test("archives interrupted project one-shots in auto mode", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          result: { value: "https://chatgpt.com/g/g-p-demo/project/c/abc" },
        })
        .mockResolvedValueOnce({
          result: {
            value: {
              status: "archived",
              conversationUrl: "https://chatgpt.com/g/g-p-demo/project/c/abc",
            },
          },
        }),
    };
    const log = vi.fn();

    await expect(
      maybeArchiveInterruptedConversationForTest({
        Runtime: runtime as never,
        logger: log as never,
        config: resolveBrowserConfig({
          archiveConversations: "auto",
          chatgptUrl: "https://chatgpt.com/g/g-p-demo/project",
        }),
        conversationUrl: "https://chatgpt.com/g/g-p-demo/project/c/abc",
        followUpCount: 0,
      }),
    ).resolves.toMatchObject({
      mode: "auto",
      attempted: true,
      archived: true,
      conversationUrl: "https://chatgpt.com/g/g-p-demo/project/c/abc",
    });
    expect(runtime.evaluate).toHaveBeenCalledTimes(2);
  });

  test("does not archive interrupted A after the controlled tab moves to B", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValueOnce({
        result: { value: "https://chatgpt.com/c/b" },
      }),
    };

    await expect(
      maybeArchiveInterruptedConversationForTest({
        Runtime: runtime as never,
        logger: vi.fn() as never,
        config: resolveBrowserConfig({ archiveConversations: "always" }),
        conversationUrl: "https://chatgpt.com/c/a",
        followUpCount: 0,
      }),
    ).resolves.toMatchObject({
      attempted: false,
      archived: false,
      reason: "archive-authority-mismatch",
      conversationUrl: "https://chatgpt.com/c/a",
    });
    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
  });

  test("does not attempt interrupted archive before a conversation exists", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValueOnce({
        result: { value: "https://chatgpt.com/g/g-p-demo/project" },
      }),
    };

    await expect(
      maybeArchiveInterruptedConversationForTest({
        Runtime: runtime as never,
        logger: vi.fn() as never,
        config: resolveBrowserConfig({
          archiveConversations: "auto",
          chatgptUrl: "https://chatgpt.com/g/g-p-demo/project",
        }),
        conversationUrl: "https://chatgpt.com/g/g-p-demo/project",
        followUpCount: 0,
      }),
    ).resolves.toBeNull();
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  test("does not attempt archive when required local artifacts were not saved", async () => {
    const runtime = {
      evaluate: vi.fn(),
    };
    const log = vi.fn();
    const promptLocator = {
      epoch: {
        status: "committed" as const,
        epochId: "archive-artifact-failure",
        promptSha256: "0".repeat(64),
        baselineTurns: 0,
        followUpOrdinal: 0,
        remainingFollowUps: 0,
        verifiedUserTurnIndex: 0,
        verifiedUserTurnId: "turn-abc",
        verifiedUserMessageId: "message-abc",
        conversationId: "abc",
      },
      conversationId: "abc",
      promptSha256: "0".repeat(64),
      verifiedUserTurnIndex: 0,
      verifiedUserTurnId: "turn-abc",
      verifiedUserMessageId: "message-abc",
      conversationUrls: ["https://chatgpt.com/c/abc"],
    };

    await expect(
      maybeArchiveCompletedConversationForTest({
        Runtime: runtime as never,
        logger: log as never,
        config: resolveBrowserConfig({ archiveConversations: "always" }),
        conversationUrl: "https://chatgpt.com/c/abc",
        promptLocator,
        followUpCount: 0,
        requiredArtifactsSaved: false,
      }),
    ).resolves.toMatchObject({
      mode: "always",
      attempted: false,
      archived: false,
      reason: "artifact-save-failed",
    });
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });
});

describe("remote Chrome option warnings", () => {
  test("does not mark browser-chrome-path as ignored for attach-running", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: true,
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    ).not.toContain("--browser-chrome-path");
  });

  test("marks browser-chrome-path as ignored for classic remote-chrome", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: false,
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    ).toContain("--browser-chrome-path");
  });
});

describe("remote Chrome cleanup", () => {
  test("unrefs a kept browser so the CLI can exit after preserving Chrome", () => {
    const unref = vi.fn();

    __test__.detachKeptChromeProcess({
      process: { unref } as never,
    });

    expect(unref).toHaveBeenCalledTimes(1);
  });

  test("closes the dedicated target after a completed run", async () => {
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: { close: closeConnection },
      client: { close: closeClient },
      runStatus: "complete",
    });

    expect(closeConnection).toHaveBeenCalledTimes(1);
    expect(closeClient).not.toHaveBeenCalled();
  });

  test("only detaches from the target after an incomplete run", async () => {
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: { close: closeConnection },
      client: { close: closeClient },
      runStatus: "attempted",
    });

    expect(closeConnection).not.toHaveBeenCalled();
    expect(closeClient).toHaveBeenCalledTimes(1);
  });

  test("detaches raw target clients when a run attaches to an existing remote tab", async () => {
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: null,
      client: { close: closeClient },
      runStatus: "complete",
    });

    expect(closeClient).toHaveBeenCalledTimes(1);
  });

  test("does not close an already-lost connection", async () => {
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: true,
      connection: { close: closeConnection },
      client: { close: closeClient },
      runStatus: "attempted",
    });

    expect(closeConnection).not.toHaveBeenCalled();
    expect(closeClient).not.toHaveBeenCalled();
  });
});

describe("image-only assistant turn detection", () => {
  test("treats ChatGPT image-only chrome text as non-answer UI", () => {
    expect(__test__.isImageOnlyUiChromeText("Stopped thinking\nEdit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("Edit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("Thought for 12s Edit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("Reasoning Thought for 12s Edit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("Pro thinking Thought for 3.5s Edit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("PR169_IMAGE_OK")).toBe(false);
  });
});

describe("redactBrowserConfigForDebugLogForTest", () => {
  test("redacts inline cookie values while preserving count context", () => {
    const redacted = redactBrowserConfigForDebugLogForTest({
      inlineCookies: [
        { name: "__Secure-next-auth.session-token", value: "secret-token" },
        { name: "_account", value: "secret-account" },
      ],
      inlineCookiesSource: "inline-file",
      debug: true,
    });

    expect(redacted).toMatchObject({
      inlineCookies: "[redacted:2 cookies]",
      inlineCookieCount: 2,
      inlineCookiesSource: "inline-file",
      debug: true,
    });
    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(JSON.stringify(redacted)).not.toContain("secret-account");
  });

  test("leaves missing inline cookies unchanged", () => {
    expect(redactBrowserConfigForDebugLogForTest({ debug: true })).toEqual({ debug: true });
  });
});

describe("shouldPreferSystemTmpDirForTest", () => {
  test("prefers /tmp for Linux tmpdirs under a hidden home segment", () => {
    expect(shouldPreferSystemTmpDirForTest("linux", "/home/openclaw/.tmp", "/home/openclaw")).toBe(
      true,
    );
    expect(
      shouldPreferSystemTmpDirForTest("linux", "/home/openclaw/.cache/tmp", "/home/openclaw"),
    ).toBe(true);
  });

  test("keeps normal Linux tmpdirs and non-Linux platforms unchanged", () => {
    expect(shouldPreferSystemTmpDirForTest("linux", "/tmp", "/home/openclaw")).toBe(false);
    expect(shouldPreferSystemTmpDirForTest("linux", "/home/openclaw/tmp", "/home/openclaw")).toBe(
      false,
    );
    expect(shouldPreferSystemTmpDirForTest("darwin", "/Users/me/.tmp", "/Users/me")).toBe(false);
  });

  test("does not treat sibling home paths as inside the home directory", () => {
    expect(shouldPreferSystemTmpDirForTest("linux", "/home/openclaw2/.tmp", "/home/openclaw")).toBe(
      false,
    );
  });
});

describe("runSubmissionWithRecoveryForTest", () => {
  test("preserves prompt-too-large fallback after a dead-composer retry", async () => {
    const promptLocator = {
      epoch: {
        status: "committed" as const,
        epochId: "epoch-1",
        promptSha256: "a".repeat(64),
        baselineTurns: 7,
        followUpOrdinal: 0,
        remainingFollowUps: 0,
        verifiedUserTurnIndex: 7,
        verifiedUserTurnId: "turn-7",
        verifiedUserMessageId: "message-7",
        conversationId: "conversation-1",
      },
      conversationId: "conversation-1",
      promptSha256: "a".repeat(64),
      verifiedUserTurnIndex: 7,
      verifiedUserTurnId: "turn-7",
      verifiedUserMessageId: "message-7",
      conversationUrls: [],
    };
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new BrowserAutomationError("dead composer", { code: "dead-composer" }))
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large", { code: "prompt-too-large" }),
      )
      .mockResolvedValueOnce({
        baselineTurns: 7,
        promptLocator,
        baselineAssistantText: "done",
      });
    const reloadPromptComposer = vi.fn().mockResolvedValue(undefined);
    const prepareFallbackSubmission = vi.fn().mockResolvedValue(undefined);
    const logger = vi.fn<(message: string) => void>();

    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "inline prompt",
        attachments: [],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [{ path: "/tmp/fallback.txt", displayPath: "fallback.txt", sizeBytes: 12 }],
        },
        submit,
        reloadPromptComposer,
        prepareFallbackSubmission,
        logger,
      }),
    ).resolves.toEqual({
      baselineTurns: 7,
      promptLocator,
      baselineAssistantText: "done",
    });

    expect(reloadPromptComposer).toHaveBeenCalledTimes(1);
    expect(prepareFallbackSubmission).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "[browser] Inline prompt too large; retrying with file uploads.",
    );
    expect(submit).toHaveBeenNthCalledWith(1, "inline prompt", []);
    expect(submit).toHaveBeenNthCalledWith(2, "inline prompt", []);
    expect(submit).toHaveBeenNthCalledWith(3, "fallback prompt", [
      expect.objectContaining({ displayPath: "fallback.txt" }),
    ]);
  });

  test("throws when prompt-too-large happens again after fallback", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large", { code: "prompt-too-large" }),
      )
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large again", { code: "prompt-too-large" }),
      );

    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "inline prompt",
        attachments: [],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [],
        },
        submit,
        reloadPromptComposer: vi.fn().mockResolvedValue(undefined),
        prepareFallbackSubmission: vi.fn().mockResolvedValue(undefined),
        logger: vi.fn<(message: string) => void>(),
      }),
    ).rejects.toThrow(/prompt too large again/i);
  });
});

describe("resolveRemoteTabLeaseProfileDirForTest", () => {
  test("coordinates remote Chrome only when a manual-login profile is configured", () => {
    const coordinated = resolveBrowserConfig({
      remoteChrome: { host: "127.0.0.1", port: 9222 },
      manualLogin: true,
      manualLoginProfileDir: "/tmp/oracle-profile",
    });
    expect(resolveRemoteTabLeaseProfileDirForTest(coordinated)).toBe(
      path.resolve("/tmp/oracle-profile"),
    );

    const uncoordinated = resolveBrowserConfig({
      remoteChrome: { host: "127.0.0.1", port: 9222 },
      manualLogin: false,
      manualLoginProfileDir: "/tmp/oracle-profile",
    });
    expect(resolveRemoteTabLeaseProfileDirForTest(uncoordinated)).toBeNull();
  });
});

describe("isLocalChromeHostForTest", () => {
  test.each(["localhost", "LOCALHOST", "127.0.0.1", "127.12.34.56", "::1", "[::1]"])(
    "accepts loopback host %s",
    (host) => {
      expect(isLocalChromeHostForTest(host)).toBe(true);
    },
  );

  test.each(["remote-host", "192.168.1.5", "10.0.0.2", "2001:db8::1"])(
    "rejects remote host %s",
    (host) => {
      expect(isLocalChromeHostForTest(host)).toBe(false);
    },
  );
});
