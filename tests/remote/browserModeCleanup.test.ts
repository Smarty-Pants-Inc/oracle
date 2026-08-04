import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";
import type * as ChromeLifecycleModule from "../../src/browser/chromeLifecycle.js";
import type * as PageActionsModule from "../../src/browser/pageActions.js";
import type { BrowserLogger } from "../../src/browser/types.js";

function runtimeFromError(error: unknown): BrowserRuntimeMetadata {
  if (!error || typeof error !== "object") throw new Error("missing browser cleanup error");
  const details = Reflect.get(error, "details");
  if (!details || typeof details !== "object") throw new Error("missing cleanup error details");
  const runtime = Reflect.get(details, "runtime");
  if (!runtime || typeof runtime !== "object") throw new Error("missing cleanup runtime");
  return runtime as BrowserRuntimeMetadata;
}

describe("remote browser unpublished cleanup", () => {
  test("surfaces finalize-bound target and lease cleanup authority and retries it", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-cleanup-retry-"));
    const originalFailure = new Error("remote navigation failed before publication");
    const closeChromeTarget = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const closeClient = vi.fn(async () => undefined);
    const client = {
      Network: { enable: vi.fn(async () => undefined) },
      Page: { enable: vi.fn(async () => undefined) },
      Runtime: {
        enable: vi.fn(async () => undefined),
        evaluate: vi.fn(async () => ({ result: { value: "about:blank" } })),
      },
      Input: {},
      DOM: { enable: vi.fn(async () => undefined) },
      Target: {},
      Emulation: { setFocusEmulationEnabled: vi.fn(async () => undefined) },
      on: vi.fn(),
      close: closeClient,
    };

    vi.resetModules();
    vi.doMock("../../src/browser/chromeLifecycle.js", async (importOriginal) => {
      const actual = await importOriginal<typeof ChromeLifecycleModule>();
      return {
        ...actual,
        connectToRemoteChrome: vi.fn(async () => ({
          client,
          targetId: "remote-cleanup-target",
          ownership: "created" as const,
          close: vi.fn(async () => undefined),
        })),
        closeChromeTarget,
      };
    });
    vi.doMock("../../src/browser/pageActions.js", async (importOriginal) => {
      const actual = await importOriginal<typeof PageActionsModule>();
      return {
        ...actual,
        navigateToChatGPT: vi.fn(async () => {
          throw originalFailure;
        }),
        installJavaScriptDialogAutoDismissal: vi.fn(() => vi.fn()),
      };
    });
    vi.doMock("../../src/browser/cookies.js", () => ({
      clearStaleChatGptConversationCookies: vi.fn(async () => undefined),
      syncCookies: vi.fn(async () => 0),
    }));
    vi.doMock("../../src/browser/conversationUrlMonitor.js", () => ({
      createConversationUrlMonitor: vi.fn(() => ({
        update: vi.fn(async () => false),
        schedule: vi.fn(),
        stop: vi.fn(async () => undefined),
      })),
    }));

    try {
      const [{ runBrowserMode }, { retryBrowserRecoveryCleanup }] = await Promise.all([
        import("../../src/browser/index.js"),
        import("../../src/browser/reattach.js"),
      ]);
      const error = await runBrowserMode({
        prompt: "remote cleanup retry",
        config: {
          remoteChrome: { host: "remote.example", port: 9333 },
          manualLogin: true,
          manualLoginProfileDir: profileDir,
          keepBrowser: false,
          cookieSync: false,
          headless: true,
          modelStrategy: "ignore",
          archiveConversations: "never",
        },
      }).catch((caught) => caught);
      const runtime = runtimeFromError(error);

      expect(error).toMatchObject({
        details: {
          stage: "browser-capture-finalization",
          code: "unpublished-cleanup-pending",
          cleanupError: "Remote Chrome target close was not confirmed",
          runtime: {
            recoveryCleanupResult: {
              status: "failed",
              error: "Remote Chrome target close was not confirmed",
              settlementMode: "finalize",
            },
            recoveryCleanupResources: [
              expect.objectContaining({
                userDataDir: profileDir,
                chromeTargetId: "remote-cleanup-target",
                tabLease: expect.any(Object),
                recoveryCleanup: expect.objectContaining({
                  ownsTarget: true,
                  keepBrowser: false,
                  closeOwnedTargetOnComplete: true,
                }),
              }),
            ],
          },
        },
      });
      expect((error as Error & { cause?: unknown }).cause).toBe(originalFailure);
      expect(
        JSON.parse(await readFile(path.join(profileDir, "oracle-tab-leases.json"), "utf8")),
      ).toMatchObject({ leases: [expect.objectContaining({ id: expect.any(String) })] });

      await expect(
        retryBrowserRecoveryCleanup(runtime, vi.fn() as BrowserLogger, {
          acquireRecoveryLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
          recoveryCleanup: { closeChromeTarget },
        }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(
        JSON.parse(await readFile(path.join(profileDir, "oracle-tab-leases.json"), "utf8")),
      ).toMatchObject({ leases: [] });
      expect(closeChromeTarget).toHaveBeenCalledTimes(2);
      expect(closeClient).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("../../src/browser/chromeLifecycle.js");
      vi.doUnmock("../../src/browser/pageActions.js");
      vi.doUnmock("../../src/browser/cookies.js");
      vi.doUnmock("../../src/browser/conversationUrlMonitor.js");
      vi.resetModules();
      await rm(profileDir, { recursive: true, force: true });
    }
  });
});
