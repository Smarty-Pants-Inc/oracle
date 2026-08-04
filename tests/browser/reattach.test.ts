import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  resumeBrowserSession,
  retryBrowserRecoveryCleanup,
  __test__,
} from "../../src/browser/reattach.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";

type FakeTarget = { id?: string; targetId?: string; type?: string; url?: string };
type FakeClient = {
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Runtime: {
    enable: () => void;
    evaluate: (params: {
      expression: string;
      returnByValue?: boolean;
    }) => Promise<{ result: { value: unknown } }>;
  };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  DOM: { enable: () => void };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Page?: { enable: () => void };
  close: () => Promise<void> | void;
};

describe("resumeBrowserSession", () => {
  test("selects target and captures markdown via stubs", async () => {
    const profileDir = path.join(os.tmpdir(), "oracle-reattach-profile");
    const runtime: BrowserRuntimeMetadata = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      userDataDir: profileDir,
      tabUrl: "https://chatgpt.com/c/abc",
      recoveryCleanup: {
        transport: "local",
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
      },
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const cleanupOrder: string[] = [];
    const close = vi.fn(async () => {
      cleanupOrder.push("connection");
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "Hello PATH plan",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "markdown response");
    const waitForConversationHydration = vi.fn(async () => 2);
    const closeChromeTarget = vi.fn(async () => {
      cleanupOrder.push("target");
      return true;
    });
    const terminateRecordedChromeForProfile = vi.fn(async () => {
      cleanupOrder.push("terminate");
      return { status: "stopped", pid: 1234, signal: "SIGTERM" } as const;
    });
    const removeProfile = vi.fn(async () => {
      cleanupOrder.push("remove-profile");
      return true;
    });
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
      waitForConversationHydration,
      recoveryCleanup: { closeChromeTarget, terminateRecordedChromeForProfile, removeProfile },
    });

    expect(result.answerMarkdown).toBe("markdown response");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 51559, target: "target-1" }),
    );
    expect(waitForAssistantResponse).toHaveBeenCalled();
    expect(captureAssistantMarkdown).toHaveBeenCalled();
    expect(waitForConversationHydration).toHaveBeenCalledWith(expect.anything(), 2000, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl: runtime.tabUrl,
    });
    expect(waitForConversationHydration.mock.invocationCallOrder[0]).toBeLessThan(
      waitForAssistantResponse.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(close).toHaveBeenCalledOnce();
    expect(cleanupOrder).toEqual(["connection"]);
    const finalization = await result.finalize();
    expect(finalization.status).toBe("completed");
    expect(cleanupOrder).toEqual(["connection", "target", "terminate", "remove-profile"]);
    expect(closeChromeTarget).toHaveBeenCalledWith(
      expect.objectContaining({ port: 51559, targetId: "target-1", retainChrome: true }),
    );
    expect(terminateRecordedChromeForProfile).toHaveBeenCalledWith(profileDir, logger);
    expect(removeProfile).toHaveBeenCalledWith(profileDir);
  });

  test("uses prompt preview turn index when reattaching to an already-open answer", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (expression.includes("const needle =")) {
        return { result: { value: 3 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "live reattach pro 123",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-4" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "live reattach pro 123");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
      waitForConversationHydration: vi.fn(async () => 2),
      promptPreview: "live reattach pro 123",
    });
    await result.abandon();

    expect(waitForAssistantResponse).toHaveBeenCalledWith(expect.anything(), 2000, logger, 3);
  });

  test("uses Deep Research completion path when reattaching research sessions", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/deep",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (expression.includes("querySelectorAll")) {
        return { result: { value: 3 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Page: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn();
    const captureAssistantMarkdown = vi.fn();
    const waitForDeepResearchCompletion = vi.fn(async () => ({
      text: "Deep report body",
      html: "<p>Deep report body</p>",
      meta: { turnId: null, messageId: null },
    }));
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(
      runtime,
      { timeoutMs: 2000, researchMode: "deep" },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        waitForDeepResearchCompletion,
        waitForConversationHydration: vi.fn(async () => 2),
      },
    );

    expect(result.answerMarkdown).toBe("Deep report body");
    expect(waitForDeepResearchCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ evaluate }),
      logger,
      2000,
      2,
      expect.any(Object),
      expect.any(Object),
      {
        requireScopedTargetOwner: true,
      },
    );
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    await result.abandon();
    expect(captureAssistantMarkdown).not.toHaveBeenCalled();
  });

  test("falls back to recovery when chrome port is missing", async () => {
    const runtime = {
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, { recoverSession });

    expect(result.answerMarkdown).toBe("fallback-md");
    expect(recoverSession).toHaveBeenCalled();
    await result.abandon();
  });

  test("tries live reattach from browser websocket metadata before falling back", async () => {
    const runtime = {
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeProfileRoot: path.join(os.tmpdir(), "oracle-attach-running-profile"),
      tabUrl: "https://chatgpt.com/c/abc",
      chromeTargetId: "target-2",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-2", type: "page", url: "https://chatgpt.com/c/abc" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "attached-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { attachRunning: true, timeoutMs: 2_000 },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        waitForConversationHydration: vi.fn(async () => 2),
      },
    );

    expect(result.answerMarkdown).toBe("attached-md");
    expect(listTargets).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "ws://127.0.0.1:9222/devtools/browser/abc",
        local: true,
      }),
    );
    await result.abandon();
  });

  test("closes the attached client before falling back to recovery", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(async () => {
      return [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[];
    }) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "must not be captured from an unhydrated shell",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const waitForConversationHydration = vi.fn(async () => {
      throw new Error("saved conversation did not hydrate");
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      waitForConversationHydration,
      recoverSession,
    });

    expect(result.answerText).toBe("fallback");
    expect(close).toHaveBeenCalledOnce();
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(recoverSession).toHaveBeenCalled();
    await result.abandon();
  });
});

describe("recovery resource finalization", () => {
  const { finalizeRecoveredRuntime } = __test__;
  const stopped = { status: "stopped", pid: 1234, signal: "SIGTERM" } as const;

  test("defers cleanup until finalize and runs the finalizer once", async () => {
    const events: string[] = [];
    const profileDir = path.join(os.tmpdir(), "oracle-reattach-fallback-profile");
    const runtime: BrowserRuntimeMetadata = {
      chromePort: 9222,
      chromeTargetId: "original-target",
      userDataDir: profileDir,
      recoveryCleanup: {
        transport: "local",
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
      },
    };
    const logger = vi.fn() as BrowserLogger;
    const result = await resumeBrowserSession(runtime, {}, logger, {
      recoverSession: vi.fn(async () => {
        events.push("fallback-capture");
        return { answerText: "fallback", answerMarkdown: "fallback" };
      }),
      recoveryCleanup: {
        closeChromeTarget: vi.fn(async () => {
          events.push("close-target");
          return true;
        }),
        terminateRecordedChromeForProfile: vi.fn(async () => {
          events.push("terminate");
          return stopped;
        }),
        removeProfile: vi.fn(async () => {
          events.push("remove-profile");
          return true;
        }),
      },
    });

    expect(events).toEqual(["fallback-capture"]);
    expect(result.runtime.recoveryCleanupResult).toEqual({ status: "pending" });
    const first = await result.finalize();
    const second = await result.finalize();
    expect(first.status).toBe("completed");
    expect(second).toBe(first);
    expect(events).toEqual(["fallback-capture", "close-target", "terminate", "remove-profile"]);
  });

  test("abandon releases authority without running cleanup", async () => {
    const finalizeResources = vi.fn(async () => ({
      status: "completed" as const,
      runtime: {},
    }));
    const abandonResources = vi.fn(async () => undefined);
    const result = await resumeBrowserSession({}, {}, vi.fn() as BrowserLogger, {
      recoverSession: vi.fn(async () => ({
        answerText: "captured",
        answerMarkdown: "captured",
        finalizeResources,
        abandonResources,
      })),
    });

    await result.abandon();
    expect(abandonResources).toHaveBeenCalledOnce();
    expect(finalizeResources).not.toHaveBeenCalled();
  });

  test("retains cleanup authority when Chrome termination is unsafe", async () => {
    const removeProfile = vi.fn(async () => true);
    const profileDir = path.join(os.tmpdir(), "oracle-browser-unsafe-cleanup");
    const result = await finalizeRecoveredRuntime(
      {
        userDataDir: profileDir,
        recoveryCleanup: {
          transport: "local",
          ownsTarget: false,
          profileKind: "copied",
          keepBrowser: false,
        },
      },
      vi.fn() as BrowserLogger,
      {
        terminateRecordedChromeForProfile: vi.fn(async () => ({
          status: "unsafe" as const,
          reason: "pid mismatch",
        })),
        removeProfile,
      },
    );

    expect(result).toMatchObject({
      status: "pending",
      runtime: {
        recoveryCleanup: { profileKind: "copied" },
        recoveryCleanupResult: { status: "failed", error: "pid mismatch" },
      },
    });
    expect(removeProfile).not.toHaveBeenCalled();
  });

  test("retries retained cleanup authority under the recovery lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-retry-test-"));
    const profileDir = path.join(os.tmpdir(), "oracle-browser-retry-cleanup");
    try {
      const result = await retryBrowserRecoveryCleanup(
        {
          userDataDir: profileDir,
          recoveryCleanup: {
            transport: "local",
            ownsTarget: false,
            profileKind: "temporary",
            keepBrowser: false,
          },
          recoveryCleanupResult: { status: "failed", error: "previous termination failure" },
        },
        vi.fn() as BrowserLogger,
        {
          recoveryLockPath: path.join(root, "browser-recovery.lock"),
          recoveryCleanup: {
            terminateRecordedChromeForProfile: vi.fn(async () => stopped),
            removeProfile: vi.fn(async () => true),
          },
        },
      );

      expect(result).toEqual({ status: "completed", runtime: { userDataDir: profileDir } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves manual-login resources while another lease is active", async () => {
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const cleanupStaleProfileState = vi.fn(async () => true);
    const result = await finalizeRecoveredRuntime(
      {
        userDataDir: path.join(os.homedir(), ".oracle", "browser-profile"),
        recoveryCleanup: {
          transport: "local",
          ownsTarget: false,
          profileKind: "manual-login",
          keepBrowser: false,
        },
      },
      vi.fn() as BrowserLogger,
      {
        teardownBrowserResourcesIfNoActiveLeases: vi.fn(async () => ({
          status: "preserved" as const,
          reason: "active-leases" as const,
        })),
        terminateRecordedChromeForProfile,
        cleanupStaleProfileState,
      },
    );

    expect(result.status).toBe("pending");
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    expect(cleanupStaleProfileState).not.toHaveBeenCalled();
  });

  test("terminates and clears manual-login state inside atomic teardown", async () => {
    const events: string[] = [];
    const profileDir = path.join(os.homedir(), ".oracle", "browser-profile");
    const cleanupStaleProfileState = vi.fn(async () => {
      events.push("cleanup-profile-state");
      return true;
    });
    const result = await finalizeRecoveredRuntime(
      {
        userDataDir: profileDir,
        recoveryCleanup: {
          transport: "local",
          ownsTarget: false,
          profileKind: "manual-login",
          keepBrowser: false,
        },
      },
      vi.fn() as BrowserLogger,
      {
        teardownBrowserResourcesIfNoActiveLeases: vi.fn(async (_dir, teardown) =>
          (await teardown())
            ? { status: "completed" as const }
            : { status: "preserved" as const, reason: "teardown-unsafe" as const },
        ),
        terminateRecordedChromeForProfile: vi.fn(async () => {
          events.push("terminate");
          return stopped;
        }),
        cleanupStaleProfileState,
      },
    );

    expect(result.status).toBe("completed");
    expect(events).toEqual(["terminate", "cleanup-profile-state"]);
    expect(cleanupStaleProfileState).toHaveBeenCalledWith(profileDir, expect.any(Function), {
      lockRemovalMode: "never",
    });
  });

  test("uses transport-aware close and never terminates remote Chrome", async () => {
    const closeChromeTarget = vi.fn(async () => true);
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const result = await finalizeRecoveredRuntime(
      {
        chromeHost: "remote.example.test",
        chromePort: 9222,
        chromeBrowserWSEndpoint: "wss://remote.example.test/devtools/browser/abc",
        chromeTargetId: "remote-owned-target",
        recoveryCleanup: {
          transport: "remote",
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: false,
        },
      },
      vi.fn() as BrowserLogger,
      { closeChromeTarget, terminateRecordedChromeForProfile },
    );

    expect(result.status).toBe("completed");
    expect(closeChromeTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "remote-owned-target",
        browserWSEndpoint: "wss://remote.example.test/devtools/browser/abc",
        retainChrome: true,
      }),
    );
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });

  test("rejects serialized temporary profiles outside approved runtime roots", async () => {
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const result = await finalizeRecoveredRuntime(
      {
        userDataDir: path.join(os.homedir(), "Downloads", "oracle-browser-malicious"),
        recoveryCleanup: {
          transport: "local",
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
      },
      vi.fn() as BrowserLogger,
      { terminateRecordedChromeForProfile },
    );

    expect(result).toMatchObject({ status: "pending", error: expect.stringMatching(/outside/) });
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });

  test("rejects noncanonical temporary profile paths before termination", async () => {
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const profileDir = `${path.join(os.tmpdir(), "oracle-browser-parent")}${path.sep}..${path.sep}oracle-browser-traversal`;
    const result = await finalizeRecoveredRuntime(
      {
        userDataDir: profileDir,
        recoveryCleanup: {
          transport: "local",
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
      },
      vi.fn() as BrowserLogger,
      { terminateRecordedChromeForProfile },
    );

    expect(result).toMatchObject({ status: "pending", error: expect.stringMatching(/canonical/) });
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });

  test("serializes concurrent recovery for one session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-lock-test-"));
    const recoveryLockPath = path.join(root, "browser-recovery.lock");
    const logger = vi.fn() as BrowserLogger;
    const recoverSession = vi.fn(async () => ({ answerText: "ok", answerMarkdown: "ok" }));
    try {
      const first = await resumeBrowserSession({}, {}, logger, {
        recoverSession,
        recoveryLockPath,
      });
      await expect(
        resumeBrowserSession({}, {}, logger, { recoverSession, recoveryLockPath }),
      ).rejects.toThrow(/already in progress/i);
      await first.abandon();
      const next = await resumeBrowserSession({}, {}, logger, { recoverSession, recoveryLockPath });
      await next.abandon();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not finalize resources after failed fallback recovery", async () => {
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const removeProfile = vi.fn(async () => true);
    const runtime: BrowserRuntimeMetadata = {
      chromePort: 9222,
      userDataDir: path.join(os.tmpdir(), "oracle-browser-failed-recovery"),
      recoveryCleanup: {
        transport: "local",
        ownsTarget: false,
        profileKind: "temporary",
        keepBrowser: false,
      },
    };

    await expect(
      resumeBrowserSession(runtime, {}, vi.fn() as BrowserLogger, {
        listTargets: vi.fn(async () => {
          throw new Error("live capture failed");
        }),
        recoverSession: vi.fn(async () => {
          throw new Error("fallback capture failed");
        }),
        recoveryCleanup: { terminateRecordedChromeForProfile, removeProfile },
      }),
    ).rejects.toThrow("fallback capture failed");
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
  });
});

describe("reattach helpers", () => {
  const {
    pickTarget,
    extractConversationIdFromUrl,
    buildConversationUrl,
    openConversationFromSidebar,
  } = __test__;
  type EvaluateParams = { expression: string };
  type EvaluateResult<T> = { result: { value: T } };

  test("extracts conversation id from a chat URL", () => {
    expect(extractConversationIdFromUrl("https://chatgpt.com/c/abc-123")).toBe("abc-123");
    expect(
      extractConversationIdFromUrl(
        "https://chatgpt.com/c/WEB:32229414-5afa-4478-890c-9ca80aa82430",
      ),
    ).toBeUndefined();
    expect(extractConversationIdFromUrl("")).toBeUndefined();
  });

  test("builds conversation URL from tabUrl or conversationId", () => {
    expect(
      buildConversationUrl(
        { tabUrl: "https://chatgpt.com/c/live", conversationId: "ignored" },
        "https://chatgpt.com/",
      ),
    ).toBe("https://chatgpt.com/c/live");
    expect(buildConversationUrl({ conversationId: "abc" }, "https://chatgpt.com/")).toBe(
      "https://chatgpt.com/c/abc",
    );
  });

  test("pickTarget prefers a saved conversation over a stale target id", () => {
    const targets = [
      { targetId: "t-1", type: "page", url: "https://chatgpt.com/c/first" },
      { targetId: "t-2", type: "page", url: "https://chatgpt.com/c/second" },
      { targetId: "t-3", type: "page", url: "about:blank" },
    ];
    expect(pickTarget(targets, { chromeTargetId: "t-2" })).toEqual(targets[1]);
    expect(
      pickTarget(targets, {
        chromeTargetId: "t-2",
        tabUrl: "https://chatgpt.com/c/first",
        conversationId: "first",
      }),
    ).toEqual(targets[0]);
    expect(pickTarget(targets, { tabUrl: "https://chatgpt.com/c/first" })).toEqual(targets[0]);
    expect(pickTarget(targets, {})).toEqual(targets[0]);
  });

  test("pickTarget keeps the saved target among duplicate conversation tabs", () => {
    const targets = [
      { targetId: "duplicate", type: "page", url: "https://chatgpt.com/c/same" },
      { targetId: "submitted", type: "page", url: "https://chatgpt.com/c/same" },
    ];

    expect(
      pickTarget(targets, {
        chromeTargetId: "submitted",
        conversationId: "same",
      }),
    ).toEqual(targets[1]);
  });

  test("pickTarget understands CDP list ids", () => {
    const targets = [
      { id: "page-1", type: "page", url: "https://chatgpt.com/c/first" },
      { id: "page-2", type: "page", url: "about:blank" },
    ];

    expect(pickTarget(targets, { chromeTargetId: "page-1" })).toEqual(targets[0]);
  });

  test("openConversationFromSidebar passes conversationId and projects preference", async () => {
    const evaluate = vi.fn<
      (
        params: EvaluateParams,
      ) => Promise<EvaluateResult<{ ok: boolean; href?: string; count: number }>>
    >(async () => ({
      result: { value: { ok: true, href: "https://chatgpt.com/c/abc", count: 3 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, {
      conversationId: "abc",
      preferProjects: true,
    });

    expect(ok).toBe(true);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain('const conversationId = "abc"');
    expect(call?.expression).toContain("const preferProjects = true");
  });

  test("openConversationFromSidebar handles missing conversationId", async () => {
    const evaluate = vi.fn<
      (params: EvaluateParams) => Promise<EvaluateResult<{ ok: boolean; count: number }>>
    >(async () => ({
      result: { value: { ok: false, count: 0 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, { preferProjects: false });

    expect(ok).toBe(false);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain("const conversationId = null");
    expect(call?.expression).toContain("const preferProjects = false");
  });
});
