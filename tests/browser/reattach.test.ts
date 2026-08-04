import { describe, expect, test, vi } from "vitest";
import { resumeBrowserSession, __test__ } from "../../src/browser/reattach.js";
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
    const runtime: BrowserRuntimeMetadata = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      userDataDir: "/tmp/oracle-reattach-profile",
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
    const closeTab = vi.fn(async () => {
      cleanupOrder.push("target");
      return true;
    });
    const terminateRecordedChromeForProfile = vi.fn(async () => {
      cleanupOrder.push("terminate");
      return true;
    });
    const removeProfile = vi.fn(async () => {
      cleanupOrder.push("remove-profile");
    });
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
      waitForConversationHydration,
      recoveryCleanup: { closeTab, terminateRecordedChromeForProfile, removeProfile },
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
    expect(cleanupOrder).toEqual(["connection", "target", "terminate", "remove-profile"]);
    expect(closeTab).toHaveBeenCalledWith(51559, "target-1", logger, "127.0.0.1");
    expect(terminateRecordedChromeForProfile).toHaveBeenCalledWith(
      "/tmp/oracle-reattach-profile",
      logger,
    );
    expect(removeProfile).toHaveBeenCalledWith("/tmp/oracle-reattach-profile");
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

    await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
      waitForConversationHydration: vi.fn(async () => 2),
      promptPreview: "live reattach pro 123",
    });

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
  });

  test("tries live reattach from browser websocket metadata before falling back", async () => {
    const runtime = {
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeProfileRoot: "/tmp/oracle-attach-running-profile",
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
  });
});

describe("recovery resource finalization", () => {
  const { finalizeRecoveredRuntime } = __test__;

  test("finalizes the original resources only after fallback capture succeeds", async () => {
    const events: string[] = [];
    const runtime: BrowserRuntimeMetadata = {
      chromePort: 9222,
      chromeTargetId: "original-target",
      userDataDir: "/tmp/oracle-fallback-profile",
      recoveryCleanup: {
        transport: "local",
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
      },
    };
    const logger = vi.fn() as BrowserLogger;
    const recoverSession = vi.fn(async () => {
      events.push("fallback-capture");
      return { answerText: "fallback", answerMarkdown: "fallback" };
    });

    await resumeBrowserSession(runtime, {}, logger, {
      recoverSession,
      recoveryCleanup: {
        closeTab: vi.fn(async () => {
          events.push("close-target");
          return true;
        }),
        terminateRecordedChromeForProfile: vi.fn(async () => {
          events.push("terminate");
          return true;
        }),
        removeProfile: vi.fn(async () => {
          events.push("remove-profile");
        }),
      },
    });

    expect(events).toEqual(["fallback-capture", "close-target", "terminate", "remove-profile"]);
  });

  test("keeps local Chrome and its profile when keepBrowser is set", async () => {
    const logger = vi.fn() as BrowserLogger;
    const closeTab = vi.fn(async () => true);
    const terminateRecordedChromeForProfile = vi.fn(async () => true);
    const removeProfile = vi.fn(async () => {});
    const runtime: BrowserRuntimeMetadata = {
      chromePort: 9222,
      chromeTargetId: "owned-target",
      userDataDir: "/tmp/oracle-kept-profile",
      recoveryCleanup: {
        transport: "local",
        ownsTarget: true,
        profileKind: "copied",
        keepBrowser: true,
        closeOwnedTargetOnComplete: true,
      },
    };

    await finalizeRecoveredRuntime(runtime, logger, {
      closeTab,
      terminateRecordedChromeForProfile,
      removeProfile,
    });

    expect(closeTab).toHaveBeenCalledWith(9222, "owned-target", logger, "127.0.0.1");
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
  });

  test("removes a copied profile when local Chrome is not kept", async () => {
    const terminateRecordedChromeForProfile = vi.fn(async () => true);
    const removeProfile = vi.fn(async () => {});
    const logger = vi.fn() as BrowserLogger;

    await finalizeRecoveredRuntime(
      {
        userDataDir: "/tmp/oracle-copied-profile",
        recoveryCleanup: {
          transport: "local",
          ownsTarget: false,
          profileKind: "copied",
          keepBrowser: false,
        },
      },
      logger,
      { terminateRecordedChromeForProfile, removeProfile },
    );

    expect(terminateRecordedChromeForProfile).toHaveBeenCalledWith(
      "/tmp/oracle-copied-profile",
      logger,
    );
    expect(removeProfile).toHaveBeenCalledWith("/tmp/oracle-copied-profile");
  });

  test("does not close an owned target retained by keepBrowser", async () => {
    const closeTab = vi.fn(async () => true);
    const logger = vi.fn() as BrowserLogger;

    await finalizeRecoveredRuntime(
      {
        chromePort: 9222,
        chromeTargetId: "retained-target",
        userDataDir: "/tmp/oracle-kept-profile",
        recoveryCleanup: {
          transport: "local",
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: true,
        },
      },
      logger,
      { closeTab },
    );

    expect(closeTab).not.toHaveBeenCalled();
  });

  test("preserves a manual-login profile while another lease is active", async () => {
    const events: string[] = [];
    const logger = vi.fn() as BrowserLogger;
    const terminateRecordedChromeForProfile = vi.fn(async () => {
      events.push("terminate");
      return true;
    });
    const cleanupStaleProfileState = vi.fn(async () => {
      events.push("cleanup-profile-state");
    });

    await finalizeRecoveredRuntime(
      {
        userDataDir: "/Users/example/.oracle/browser-profile",
        recoveryCleanup: {
          transport: "local",
          ownsTarget: false,
          profileKind: "manual-login",
          keepBrowser: false,
        },
      },
      logger,
      {
        hasOtherActiveBrowserTabLeases: vi.fn(async () => {
          events.push("check-leases");
          return true;
        }),
        terminateRecordedChromeForProfile,
        cleanupStaleProfileState,
      },
    );

    expect(events).toEqual(["check-leases"]);
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    expect(cleanupStaleProfileState).not.toHaveBeenCalled();
  });

  test("terminates and clears stale state after the final manual-login lease", async () => {
    const events: string[] = [];
    const logger = vi.fn() as BrowserLogger;
    const terminateRecordedChromeForProfile = vi.fn(async () => {
      events.push("terminate");
      return true;
    });
    const cleanupStaleProfileState = vi.fn(async () => {
      events.push("cleanup-profile-state");
    });
    const removeProfile = vi.fn(async () => {
      events.push("remove-profile");
    });

    await finalizeRecoveredRuntime(
      {
        userDataDir: "/Users/example/.oracle/browser-profile",
        recoveryCleanup: {
          transport: "local",
          ownsTarget: false,
          profileKind: "manual-login",
          keepBrowser: false,
        },
      },
      logger,
      {
        hasOtherActiveBrowserTabLeases: vi.fn(async () => {
          events.push("check-leases");
          return false;
        }),
        terminateRecordedChromeForProfile,
        cleanupStaleProfileState,
        removeProfile,
      },
    );

    expect(events).toEqual(["check-leases", "terminate", "cleanup-profile-state"]);
    expect(cleanupStaleProfileState).toHaveBeenCalledWith(
      "/Users/example/.oracle/browser-profile",
      logger,
      { lockRemovalMode: "never" },
    );
    expect(removeProfile).not.toHaveBeenCalled();
  });

  test("never terminates remote Chrome or removes its profile", async () => {
    const closeTab = vi.fn(async () => true);
    const terminateRecordedChromeForProfile = vi.fn(async () => true);
    const cleanupStaleProfileState = vi.fn(async () => {});
    const removeProfile = vi.fn(async () => {});
    const logger = vi.fn() as BrowserLogger;

    await finalizeRecoveredRuntime(
      {
        chromeHost: "remote.example.test",
        chromePort: 9222,
        chromeTargetId: "remote-owned-target",
        userDataDir: "/tmp/remote-profile",
        recoveryCleanup: {
          transport: "remote",
          ownsTarget: true,
          profileKind: "temporary",
          keepBrowser: false,
        },
      },
      logger,
      { closeTab, terminateRecordedChromeForProfile, cleanupStaleProfileState, removeProfile },
    );

    expect(closeTab).toHaveBeenCalledWith(
      9222,
      "remote-owned-target",
      logger,
      "remote.example.test",
    );
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    expect(cleanupStaleProfileState).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
  });

  test("does nothing without recovery cleanup metadata", async () => {
    const closeTab = vi.fn(async () => true);
    const terminateRecordedChromeForProfile = vi.fn(async () => true);
    const cleanupStaleProfileState = vi.fn(async () => {});
    const hasOtherActiveBrowserTabLeases = vi.fn(async () => false);
    const removeProfile = vi.fn(async () => {});
    const logger = vi.fn() as BrowserLogger;

    await finalizeRecoveredRuntime(
      {
        chromePort: 9222,
        chromeTargetId: "target",
        userDataDir: "/tmp/oracle-profile",
      },
      logger,
      {
        closeTab,
        terminateRecordedChromeForProfile,
        cleanupStaleProfileState,
        hasOtherActiveBrowserTabLeases,
        removeProfile,
      },
    );

    expect(closeTab).not.toHaveBeenCalled();
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    expect(cleanupStaleProfileState).not.toHaveBeenCalled();
    expect(hasOtherActiveBrowserTabLeases).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
  });

  test("does not finalize resources after failed fallback recovery", async () => {
    const terminateRecordedChromeForProfile = vi.fn(async () => true);
    const removeProfile = vi.fn(async () => {});
    const logger = vi.fn() as BrowserLogger;
    const runtime: BrowserRuntimeMetadata = {
      chromePort: 9222,
      userDataDir: "/tmp/oracle-failed-recovery",
      recoveryCleanup: {
        transport: "local",
        ownsTarget: false,
        profileKind: "temporary",
        keepBrowser: false,
      },
    };

    await expect(
      resumeBrowserSession(runtime, {}, logger, {
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
