import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { resumeBrowserSession, __test__ } from "../../src/browser/reattach.js";
import type { ChromeClient } from "../../src/browser/types.js";
import {
  authenticatedLocalTargetCleanupDeps,
  createBrowserLogger,
  physicalChromeProcessIdentity,
  resumeFallbackWithManualOwner,
  withCommittedPromptEpoch,
} from "./reattachTestHelpers.js";

describe("resumeBrowserSession fallback acquisition", { timeout: 15_000 }, () => {
  test("fallback reattach uses retained kill authority for a temporary Chrome launch", async () => {
    let profileDir: string | null = null;
    const cleanupOrder: string[] = [];
    const kill = vi.fn(async () => {
      cleanupOrder.push("kill");
      return { status: "stopped" as const, pid: 4321, signal: "SIGTERM" as const };
    });
    const acquireTemporaryChromeOwner = vi.fn(
      async (_resolved: unknown, launchedProfileDir: string) => {
        profileDir = launchedProfileDir;
        const processIdentity = await physicalChromeProcessIdentity(launchedProfileDir, 4321);
        return {
          pid: 4321,
          port: 9222,
          host: "127.0.0.1",
          remoteDebuggingPipes: undefined,
          processIdentity,
          endpointAuthority: {
            browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/fallback-temporary",
            kill,
            runExactOperation: vi.fn(),
            release: vi.fn(async () => undefined),
          },
          kill,
        };
      },
    );
    const Runtime = {
      enable: vi.fn(async () => undefined),
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) return { result: { value: "complete" } };
        if (expression.includes("hasChallengeScript")) {
          return { result: { value: { shell: true } } };
        }
        if (expression.includes("suspicious activity detected"))
          return { result: { value: false } };
        if (expression.includes("/api/auth/session")) {
          return { result: { value: { ok: true, status: 200, sessionAuthenticated: true } } };
        }
        if (expression.includes("const selectors =")) return { result: { value: true } };
        throw new Error(`Unexpected Runtime.evaluate expression: ${expression}`);
      }),
    };
    const client = {
      Runtime,
      DOM: { enable: vi.fn(async () => undefined) },
      Page: { enable: vi.fn(async () => undefined), navigate: vi.fn(async () => undefined) },
      Network: { getAllCookies: vi.fn(async () => ({ cookies: [] })) },
      Target: { getTargets: vi.fn(async () => ({ targetInfos: [] })) },
      close: vi.fn(async () => undefined),
    } as unknown as ChromeClient;
    const connectRecoveryTargetWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
      value: {
        client,
        targetId: "fallback-owned-target",
        ownership: "created" as const,
        close: vi.fn(async () => undefined),
      },
    }));
    const exactCleanupDeps = authenticatedLocalTargetCleanupDeps({
      closeTarget: () => {
        cleanupOrder.push("target");
        return { status: "completed" };
      },
      mockRetainedTargetClose: false,
    });
    const terminateRecordedChromeForProfile = vi.fn(async () => ({
      status: "unsafe" as const,
      pid: 4321,
      reason: "persisted owner lookup cannot safely terminate the still-live launch",
    }));
    const removeProfile = vi.fn(async () => {
      cleanupOrder.push("remove-profile");
      return true;
    });

    try {
      const result = await resumeBrowserSession(
        withCommittedPromptEpoch({ tabUrl: "https://chatgpt.com/c/test-conversation" }),
        { cookieSync: false, headless: true, manualLogin: false, timeoutMs: 1_000 },
        createBrowserLogger(),
        {
          launchChrome: acquireTemporaryChromeOwner as never,
          acquireRecoveryLock: vi.fn(async () => ({
            release: vi.fn(async () => undefined),
          })),
          connectRecoveryTargetWithExactAuthority: connectRecoveryTargetWithExactAuthority as never,
          waitForConversationHydration: vi.fn(async () => 1),
          verifyCommittedPromptTurn: vi.fn(async () => undefined),
          waitForAssistantResponse: vi.fn(async () => ({
            text: "fallback answer",
            html: "",
            meta: { messageId: "assistant-2", turnId: "turn-2" },
          })),
          captureAssistantMarkdown: vi.fn(async () => "fallback markdown"),
          recoveryCleanup: {
            ...exactCleanupDeps,
            terminateRecordedChromeForProfile,
            removeProfile,
          },
        },
      );
      expect(acquireTemporaryChromeOwner).toHaveBeenCalledWith(
        expect.objectContaining({ headless: true }),
        expect.stringMatching(/oracle-reattach-/),
        expect.any(Function),
        {
          launchClaim: expect.objectContaining({
            version: 1,
            generationId: expect.any(String),
            nonce: expect.any(String),
          }),
        },
      );
      expect(result.runtime.chromeBrowserWSEndpoint).toBe(
        "ws://127.0.0.1:9222/devtools/browser/fallback-temporary",
      );

      await expect(result.abort()).resolves.toMatchObject({ status: "completed" });
      expect(exactCleanupDeps.closeChromeTargetWithExactAuthority).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: "fallback-owned-target" }),
      );
      expect(connectRecoveryTargetWithExactAuthority).toHaveBeenCalledWith(
        expect.objectContaining({
          authority: expect.objectContaining({
            browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/fallback-temporary",
          }),
          targetUrl: expect.stringContaining("oracle-acquisition="),
          closeTargetOnDispose: false,
        }),
      );
      expect(kill).toHaveBeenCalledOnce();
      expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
      expect(cleanupOrder).toEqual(["target", "kill", "remove-profile"]);
    } finally {
      if (profileDir) await rm(profileDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("fallback reattach tears down a launched manual-login Chrome owner", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-launched-owner-"));
    try {
      const {
        result,
        closeChromeTargetWithExactAuthority,
        terminateRecordedChromeForProfile,
        cleanupStaleProfileState,
        kill,
        releaseEndpointAuthority,
        cleanupOrder,
        releaseRecoveryLock,
      } = await resumeFallbackWithManualOwner(profileDir, "launched");

      expect(result.runtime.recoveryCleanupResources).toEqual([
        expect.objectContaining({
          chromeTargetId: "fallback-owned-target",
          tabLease: expect.any(Object),
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "manual-login",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        }),
      ]);
      await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
      expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: "fallback-owned-target" }),
      );
      expect(kill).toHaveBeenCalledOnce();
      expect(releaseEndpointAuthority).toHaveBeenCalledOnce();
      expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
      expect(cleanupStaleProfileState).toHaveBeenCalledOnce();
      expect(releaseRecoveryLock).toHaveBeenCalledOnce();
      expect(cleanupOrder).toEqual(["target", "lease", "kill", "cleanup-profile", "endpoint"]);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 15_000);

  test.each(["recorded", "rediscovered"] as const)(
    "fallback reattach preserves a %s manual-login Chrome owner while cleaning its target and lease",
    async (source) => {
      const profileDir = await mkdtemp(path.join(os.tmpdir(), `oracle-reattach-${source}-owner-`));
      try {
        const {
          result,
          closeChromeTargetWithExactAuthority,
          terminateRecordedChromeForProfile,
          cleanupStaleProfileState,
          kill,
          releaseEndpointAuthority,
          cleanupOrder,
          releaseRecoveryLock,
        } = await resumeFallbackWithManualOwner(profileDir, source);

        expect(result.runtime.recoveryCleanupResources).toEqual([
          expect.objectContaining({
            chromeTargetId: "fallback-owned-target",
            tabLease: expect.any(Object),
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "manual-login",
              keepBrowser: true,
              closeOwnedTargetOnComplete: true,
            },
          }),
        ]);
        await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
        expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledWith(
          expect.objectContaining({ targetId: "fallback-owned-target" }),
        );
        expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
        expect(cleanupStaleProfileState).not.toHaveBeenCalled();
        expect(kill).not.toHaveBeenCalled();
        expect(releaseEndpointAuthority).toHaveBeenCalledOnce();
        expect(releaseRecoveryLock).toHaveBeenCalledOnce();
        expect(cleanupOrder).toEqual(["target", "lease", "endpoint"]);
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
  );

  test("fallback active-lease handoff releases only retained endpoint authority", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-active-owner-"));
    try {
      const { result, kill, cleanupStaleProfileState, releaseEndpointAuthority, cleanupOrder } =
        await resumeFallbackWithManualOwner(profileDir, "launched", { isLastLease: false });

      await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
      expect(kill).not.toHaveBeenCalled();
      expect(cleanupStaleProfileState).not.toHaveBeenCalled();
      expect(releaseEndpointAuthority).toHaveBeenCalledOnce();
      expect(cleanupOrder).toEqual(["target", "lease", "endpoint"]);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("fallback endpoint release failure retains retryable settled cleanup authority", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-endpoint-retry-"));
    try {
      const { result, kill, releaseEndpointAuthority, runtimeHints } =
        await resumeFallbackWithManualOwner(profileDir, "recorded", { endpointReleaseFailures: 1 });

      const pending = await result.finalize();
      expect(pending).toMatchObject({
        status: "pending",
        runtime: {
          chromeTargetId: undefined,
          recoveryCleanupResources: [
            {
              chromeTargetId: undefined,
              tabLease: undefined,
              recoveryCleanup: {
                ownsTarget: false,
                profileKind: "manual-login",
                keepBrowser: true,
              },
            },
          ],
        },
        error: "Exact Chrome endpoint release failed: transient endpoint release failure",
      });
      expect(runtimeHints.at(-1)).toMatchObject({
        chromeTargetId: undefined,
        recoveryCleanupResources: [
          {
            chromeTargetId: undefined,
            tabLease: undefined,
            recoveryCleanup: { ownsTarget: false, keepBrowser: true },
          },
        ],
        recoveryCleanupResult: { status: "failed", settlementMode: "finalize" },
      });
      expect(kill).not.toHaveBeenCalled();
      await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
      expect(releaseEndpointAuthority).toHaveBeenCalledTimes(2);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });
});
