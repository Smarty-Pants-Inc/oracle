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
  test("surfaces abort-bound target and lease cleanup authority and retries it", async () => {
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
              settlementMode: "abort",
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
  }, 15_000);

  test("journals an unleased direct target before acquisition and excludes borrowed tabs", async () => {
    const originalFailure = new Error("remote navigation failed after target acquisition");
    const targetId = "remote-direct-target";
    const acquisitionOrder: string[] = [];
    const persistedRuntimes: BrowserRuntimeMetadata[] = [];
    const borrowedRuntimes: BrowserRuntimeMetadata[] = [];
    const closeChromeTarget = vi.fn(async () => true);
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") return { result: { value: "about:blank" } };
      if (expression.includes("const title = String(document.title")) {
        return { result: { value: { strong: false, shell: true, weak: false } } };
      }
      if (expression.includes("suspicious activity detected")) {
        return { result: { value: false } };
      }
      throw new Error(`Unexpected Runtime.evaluate expression: ${expression}`);
    });
    const client = {
      Network: { enable: vi.fn(async () => undefined) },
      Page: { enable: vi.fn(async () => undefined) },
      Runtime: { enable: vi.fn(async () => undefined), evaluate },
      Input: {},
      DOM: { enable: vi.fn(async () => undefined) },
      Target: {},
      Emulation: { setFocusEmulationEnabled: vi.fn(async () => undefined) },
      on: vi.fn(),
      close: vi.fn(async () => undefined),
    };

    vi.resetModules();
    vi.doMock("../../src/browser/chromeLifecycle.js", async (importOriginal) => {
      const actual = await importOriginal<typeof ChromeLifecycleModule>();
      return {
        ...actual,
        connectToRemoteChrome: vi.fn(async () => {
          acquisitionOrder.push("acquire:target");
          return {
            client,
            targetId,
            ownership: "created" as const,
            close: vi.fn(async () => undefined),
          };
        }),
        closeChromeTarget,
      };
    });
    vi.doMock("../../src/browser/liveTabs.js", () => ({
      connectToExistingChatGptTab: vi.fn(async () => {
        acquisitionOrder.push("acquire:borrowed-tab");
        return {
          client,
          targetId: "borrowed-target",
          tab: { url: "https://chatgpt.com/c/borrowed-target" },
        };
      }),
    }));
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
      const [{ runBrowserMode }, { __test__: reattachTest }] = await Promise.all([
        import("../../src/browser/index.js"),
        import("../../src/browser/reattach.js"),
      ]);
      await runBrowserMode({
        prompt: "direct target journal",
        config: {
          remoteChrome: { host: "remote.example", port: 9333 },
          keepBrowser: false,
          cookieSync: false,
          headless: true,
          modelStrategy: "ignore",
          archiveConversations: "never",
        },
        runtimeHintCb: async (runtime) => {
          persistedRuntimes.push(structuredClone(runtime));
          const resource = runtime.recoveryCleanupResources?.[0];
          if (resource?.acquisition?.pendingResource === "chrome-target") {
            acquisitionOrder.push("persist:marker-intent");
          } else if (resource?.chromeTargetId === targetId) {
            acquisitionOrder.push("persist:exact-target");
          }
        },
      }).catch((caught) => {
        expect(caught).toBe(originalFailure);
      });

      expect(acquisitionOrder.slice(0, 3)).toEqual([
        "persist:marker-intent",
        "acquire:target",
        "persist:exact-target",
      ]);
      const markerRuntime = persistedRuntimes.find(
        (runtime) =>
          runtime.recoveryCleanupResources?.[0]?.acquisition?.pendingResource === "chrome-target",
      );
      if (!markerRuntime) throw new Error("direct target acquisition marker was not persisted");
      const markerResource = markerRuntime.recoveryCleanupResources?.[0];
      if (!markerResource) throw new Error("direct target cleanup resource was not persisted");
      expect(markerRuntime.chromeTargetId).toBeUndefined();
      expect(markerResource).toEqual(
        expect.objectContaining({
          chromeTargetId: undefined,
          acquisition: expect.objectContaining({ pendingResource: "chrome-target" }),
          recoveryCleanup: expect.objectContaining({ ownsTarget: true }),
        }),
      );
      const markerGenerationId = markerResource.acquisition?.generationId;
      if (!markerGenerationId) throw new Error("direct target generation was not persisted");
      const markerUrl = markerResource.acquisition?.targetMarkerUrl;
      expect(markerUrl).toBe(`about:blank#oracle-acquisition=${markerGenerationId}`);
      if (!markerUrl) throw new Error("direct target marker URL was not persisted");
      const listChromeTargets = vi.fn(async () => [
        { targetId: "marker-discovered-target", type: "page", url: markerUrl },
      ]);
      await expect(
        reattachTest.finalizeRecoveredRuntime(
          markerRuntime,
          vi.fn() as BrowserLogger,
          { closeChromeTarget, listChromeTargets },
          "abort",
        ),
      ).resolves.toMatchObject({ status: "completed" });
      expect(listChromeTargets).toHaveBeenCalledWith({
        host: "remote.example",
        port: 9333,
        browserWSEndpoint: undefined,
      });
      expect(closeChromeTarget).toHaveBeenLastCalledWith(
        expect.objectContaining({
          host: "remote.example",
          port: 9333,
          targetId: "marker-discovered-target",
        }),
      );

      await runBrowserMode({
        prompt: "borrowed tab remains unowned",
        config: {
          remoteChrome: { host: "remote.example", port: 9333 },
          browserTabRef: "borrowed-tab-ref",
          resumeConversationUrl: "https://chatgpt.com/c/borrowed-target",
          keepBrowser: false,
          cookieSync: false,
          headless: true,
          modelStrategy: "ignore",
          archiveConversations: "never",
        },
        runtimeHintCb: async (runtime) => {
          borrowedRuntimes.push(structuredClone(runtime));
        },
      }).catch((caught) => {
        expect(caught).toBe(originalFailure);
      });
      const borrowedRuntime = borrowedRuntimes.find(
        (runtime) => runtime.chromeTargetId === "borrowed-target",
      );
      expect(borrowedRuntime).toMatchObject({
        recoveryCleanupResources: [
          expect.objectContaining({
            acquisition: { generationId: expect.any(String) },
            recoveryCleanup: expect.objectContaining({ ownsTarget: false }),
          }),
        ],
      });
      expect(
        borrowedRuntime?.recoveryCleanupResources?.[0]?.acquisition?.pendingResource,
      ).toBeUndefined();
      expect(
        borrowedRuntime?.recoveryCleanupResources?.[0]?.acquisition?.targetMarkerUrl,
      ).toBeUndefined();
    } finally {
      vi.doUnmock("../../src/browser/chromeLifecycle.js");
      vi.doUnmock("../../src/browser/liveTabs.js");
      vi.doUnmock("../../src/browser/pageActions.js");
      vi.doUnmock("../../src/browser/cookies.js");
      vi.doUnmock("../../src/browser/conversationUrlMonitor.js");
      vi.resetModules();
    }
  });
});
