import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenBrowserUseConnection } from "../../src/browser/openBrowserUse.js";
import type { ChatGptTabSummary } from "../../src/browser/liveTabs.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

const mocks = vi.hoisted(() => ({
  readSession: vi.fn(),
  updateSession: vi.fn(),
  acquireOpenBrowserUseRunLock: vi.fn(),
  connectOpenBrowserUseTab: vi.fn(),
  prepareOpenBrowserUseConversationRoute: vi.fn(),
  waitForOpenBrowserUseConversationUrl: vi.fn(),
  harvestConnectedChatGptTab: vi.fn(),
  ensureChatGptScopeRetained: vi.fn(),
}));

vi.mock("../../src/sessionStore.ts", () => ({
  sessionStore: {
    readSession: mocks.readSession,
    updateSession: mocks.updateSession,
  },
}));

vi.mock("../../src/browser/openBrowserUse.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/browser/openBrowserUse.js")>();
  return {
    ...actual,
    acquireOpenBrowserUseRunLock: mocks.acquireOpenBrowserUseRunLock,
    connectOpenBrowserUseTab: mocks.connectOpenBrowserUseTab,
    prepareOpenBrowserUseConversationRoute: mocks.prepareOpenBrowserUseConversationRoute,
    waitForOpenBrowserUseConversationUrl: mocks.waitForOpenBrowserUseConversationUrl,
  };
});

vi.mock("../../src/browser/liveTabs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/browser/liveTabs.js")>();
  return {
    ...actual,
    harvestConnectedChatGptTab: mocks.harvestConnectedChatGptTab,
  };
});

vi.mock("../../src/browser/pageActions.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/browser/pageActions.js")>();
  return { ...actual, ensureChatGptScopeRetained: mocks.ensureChatGptScopeRetained };
});

import { harvestSessionBrowserOutput } from "../../src/cli/browserTabs.js";

const conversationUrl = "https://chatgpt.com/c/obu-thread";
const accountDigest = "a".repeat(64);
const workspaceDigest = "b".repeat(64);

function obuSession(): SessionMetadata {
  const route = {
    browserTransport: "obu" as const,
    obuSessionId: "stored-session",
    obuTabId: 7,
    chatGptAccountEmail: "paul@smartypants.ai",
    chatGptWorkspaceName: "Paul Bettner",
    chatGptAccountDigest: accountDigest,
    chatGptWorkspaceDigest: workspaceDigest,
  };
  return {
    id: "obu-session",
    createdAt: "2026-08-22T00:00:00.000Z",
    status: "completed",
    options: { browserConfig: route },
    browser: {
      config: route,
      runtime: {
        ...route,
        tabUrl: conversationUrl,
        conversationId: "obu-thread",
      },
    },
  };
}

const harvested: ChatGptTabSummary = {
  targetId: "8",
  title: "Oracle",
  url: conversationUrl,
  currentModelLabel: "Pro",
  stopExists: false,
  sendExists: true,
  promptReady: true,
  loginButtonExists: false,
  authenticated: true,
  assistantFollowsLatestUser: true,
  assistantCount: 1,
  lastAssistantText: "done",
  lastAssistantSnippet: "done",
  lastUserText: "question",
  lastUserSnippet: "question",
  focused: false,
  visibilityState: "visible",
  conversationId: "obu-thread",
  fingerprint: "fingerprint",
  state: "completed",
  lastAssistantMarkdown: "done",
};

describe("main-Chrome harvest recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.updateSession.mockResolvedValue(undefined);
    mocks.acquireOpenBrowserUseRunLock.mockResolvedValue({
      path: "/tmp/oracle.lock",
      lockId: "lock-1",
      release: vi.fn(async () => {}),
    });
    mocks.harvestConnectedChatGptTab.mockResolvedValue(harvested);
    mocks.ensureChatGptScopeRetained.mockResolvedValue(undefined);
    mocks.prepareOpenBrowserUseConversationRoute.mockResolvedValue({
      email: "paul@smartypants.ai",
      workspaceName: "Paul Bettner",
      accountDigest,
      workspaceDigest,
    });
    mocks.waitForOpenBrowserUseConversationUrl.mockResolvedValue(conversationUrl);
  });

  test("closes an unverified recovered tab and preserves the primary session error", async () => {
    const meta = obuSession();
    meta.errorMessage = "primary run failed";
    meta.error = { category: "browser-automation", message: "primary run failed" };
    const finalize = vi.fn(async (_keepTab: boolean) => {});
    const recoveredConnection = {
      client: {},
      obuClient: {},
      sessionId: "recovered-session",
      tabId: 8,
      tabUrl: conversationUrl,
      created: true,
      finalize,
    } as unknown as OpenBrowserUseConnection;
    mocks.readSession.mockResolvedValue(meta);
    mocks.connectOpenBrowserUseTab.mockResolvedValue(recoveredConnection);
    mocks.prepareOpenBrowserUseConversationRoute
      .mockRejectedValueOnce(
        new BrowserAutomationError("ChatGPT left the stored thread.", {
          stage: "chatgpt-scope",
          code: "scope-mismatch",
        }),
      )
      .mockResolvedValue({
        email: "paul@smartypants.ai",
        workspaceName: "Paul Bettner",
        accountDigest,
        workspaceDigest,
      });

    await expect(harvestSessionBrowserOutput(meta.id, { quietOutput: true })).rejects.toMatchObject(
      {
        details: { stage: "chatgpt-scope", code: "scope-mismatch" },
      },
    );
    expect(finalize).toHaveBeenCalledWith(false);
    expect(
      mocks.updateSession.mock.calls.some(([, patch]) => {
        const update = patch as Partial<SessionMetadata>;
        return update.browser?.config?.obuSessionId === "recovered-session";
      }),
    ).toBe(false);
    const failedUpdate = mocks.updateSession.mock.calls.at(-1)?.[1] as
      | Partial<SessionMetadata>
      | undefined;
    expect(failedUpdate?.browser?.operationErrors?.harvest?.details).toMatchObject({
      oracleOperation: "harvest",
    });
    expect(failedUpdate).not.toHaveProperty("error");
    expect(meta.error?.message).toBe("primary run failed");
    mocks.updateSession.mockClear();
    finalize.mockClear();

    await expect(
      harvestSessionBrowserOutput(meta.id, { quietOutput: true }),
    ).resolves.toMatchObject({ conversationId: "obu-thread", state: "completed" });
    expect(finalize).toHaveBeenCalledWith(false);
    expect(mocks.updateSession).toHaveBeenCalledWith(meta.id, {
      browser: expect.objectContaining({
        operationErrors: undefined,
        harvest: expect.objectContaining({ conversationId: "obu-thread", state: "completed" }),
      }),
    });
    expect(meta.error?.message).toBe("primary run failed");
  });
  test("retains the lock when harvest tab finalization is inconclusive", async () => {
    const meta = obuSession();
    const release = vi.fn(async () => {});
    const markUncertain = vi.fn(async () => {});
    const finalize = vi.fn().mockRejectedValue(
      new BrowserAutomationError("Harvest tab finalization failed.", {
        stage: "open-browser-use",
        code: "tab-finalize-failed",
        recoveryHandle: { transport: "obu", sessionId: "recovered-session", tabId: 8 },
      }),
    );
    mocks.acquireOpenBrowserUseRunLock.mockResolvedValueOnce({
      path: "/tmp/oracle.lock",
      lockId: "lock-1",
      release,
      markUncertain,
    });
    mocks.readSession.mockResolvedValue(meta);
    mocks.connectOpenBrowserUseTab.mockResolvedValue({
      client: {},
      obuClient: {},
      sessionId: "recovered-session",
      tabId: 8,
      tabUrl: conversationUrl,
      created: true,
      finalize,
    } as unknown as OpenBrowserUseConnection);

    await expect(
      harvestSessionBrowserOutput(meta.id, { quietOutput: true }),
    ).resolves.toMatchObject({ conversationId: "obu-thread", state: "completed" });
    expect(finalize).toHaveBeenCalledWith(false);
    expect(markUncertain).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringMatching(/finalization was inconclusive/i) }),
    );
    expect(release).not.toHaveBeenCalled();
    expect(
      mocks.updateSession.mock.calls.some(([, patch]) => {
        const update = patch as Partial<SessionMetadata>;
        return update.browser?.warnings?.some(
          (warning) => warning.code === "obu-tab-finalize-failed",
        );
      }),
    ).toBe(true);
  });

  test("waits for a recovered conversation to hydrate before closing it", async () => {
    vi.useFakeTimers();
    try {
      const meta = obuSession();
      const finalize = vi.fn(async (_keepTab: boolean) => {});
      mocks.readSession.mockResolvedValue(meta);
      mocks.connectOpenBrowserUseTab.mockResolvedValue({
        client: {},
        obuClient: {},
        sessionId: "recovered-session",
        tabId: 8,
        tabUrl: conversationUrl,
        created: true,
        finalize,
      } as unknown as OpenBrowserUseConnection);
      mocks.harvestConnectedChatGptTab
        .mockResolvedValueOnce({
          ...harvested,
          assistantCount: 0,
          assistantFollowsLatestUser: false,
          lastAssistantText: "",
          lastAssistantSnippet: "",
          lastAssistantMarkdown: null,
        })
        .mockResolvedValueOnce(harvested);

      const result = harvestSessionBrowserOutput(meta.id, { quietOutput: true });
      await vi.runAllTimersAsync();
      await expect(result).resolves.toMatchObject({ conversationId: "obu-thread" });
      expect(mocks.harvestConnectedChatGptTab).toHaveBeenCalledTimes(2);
      expect(finalize).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("retries missing stored turn affinity while the conversation hydrates", async () => {
    vi.useFakeTimers();
    try {
      const meta = obuSession();
      const finalize = vi.fn(async (_keepTab: boolean) => {});
      mocks.readSession.mockResolvedValue(meta);
      mocks.connectOpenBrowserUseTab.mockResolvedValue({
        client: {},
        obuClient: {},
        sessionId: "recovered-session",
        tabId: 8,
        tabUrl: conversationUrl,
        created: true,
        finalize,
      } as unknown as OpenBrowserUseConnection);
      mocks.harvestConnectedChatGptTab
        .mockRejectedValueOnce(
          new BrowserAutomationError("Stored turn is not hydrated yet.", {
            stage: "chatgpt-turn-affinity",
            code: "turn-affinity-missing",
          }),
        )
        .mockResolvedValueOnce(harvested);

      const result = harvestSessionBrowserOutput(meta.id, { quietOutput: true });
      await vi.runAllTimersAsync();
      await expect(result).resolves.toMatchObject({ conversationId: "obu-thread" });
      expect(mocks.harvestConnectedChatGptTab).toHaveBeenCalledTimes(2);
      expect(finalize).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects a scope change before retrying missing turn affinity", async () => {
    const meta = obuSession();
    const finalize = vi.fn(async (_keepTab: boolean) => {});
    mocks.readSession.mockResolvedValue(meta);
    mocks.connectOpenBrowserUseTab.mockResolvedValue({
      client: {},
      obuClient: {},
      sessionId: "recovered-session",
      tabId: 8,
      tabUrl: conversationUrl,
      created: true,
      finalize,
    } as unknown as OpenBrowserUseConnection);
    mocks.ensureChatGptScopeRetained.mockRejectedValueOnce(
      new BrowserAutomationError("ChatGPT left the stored thread.", {
        stage: "chatgpt-scope",
        code: "scope-mismatch",
      }),
    );

    await expect(harvestSessionBrowserOutput(meta.id, { quietOutput: true })).rejects.toMatchObject(
      { details: { stage: "chatgpt-scope", code: "scope-mismatch" } },
    );
    expect(mocks.harvestConnectedChatGptTab).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith(true);
  });

  test("rejects a harvested root/project route change with the same conversation id", async () => {
    const meta = obuSession();
    const projectUrl = "https://chatgpt.com/g/project-a/c/obu-thread";
    meta.browser!.runtime!.tabUrl = projectUrl;
    const finalize = vi.fn(async (_keepTab: boolean) => {});
    mocks.readSession.mockResolvedValue(meta);
    mocks.connectOpenBrowserUseTab.mockResolvedValue({
      client: {},
      obuClient: {},
      sessionId: "recovered-session",
      tabId: 8,
      tabUrl: projectUrl,
      created: true,
      finalize,
    } as unknown as OpenBrowserUseConnection);

    await expect(harvestSessionBrowserOutput(meta.id, { quietOutput: true })).rejects.toMatchObject(
      {
        details: { stage: "chatgpt-scope", code: "scope-mismatch" },
      },
    );
    expect(mocks.harvestConnectedChatGptTab).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(true);
  });

  test("redacts nested persisted recovery details without changing the immediate error", async () => {
    const meta = obuSession();
    const signedUrl =
      "https://chatgpt.com/c/private-thread?signature=secret&expires=9999999999#private";
    const finalize = vi.fn(async () => {
      throw new BrowserAutomationError(`Cleanup failed at ${signedUrl}`, {
        stage: "open-browser-use",
        code: "tab-finalize-failed",
        recoveryHandle: {
          transport: "obu",
          sessionId: "cleanup-session",
          tabId: 9,
          conversationUrl: signedUrl,
        },
      });
    });
    const primaryError = new BrowserAutomationError(`Scope changed at ${signedUrl}`, {
      stage: "chatgpt-scope",
      code: "scope-mismatch",
      actualUrl: signedUrl,
      recoveryHandle: {
        transport: "obu",
        sessionId: "recovered-session",
        tabId: 8,
        conversationUrl: signedUrl,
      },
      sessionStatus: "needs_login",
    });
    mocks.readSession.mockResolvedValue(meta);
    mocks.connectOpenBrowserUseTab.mockResolvedValue({
      client: {},
      obuClient: {},
      sessionId: "recovered-session",
      tabId: 8,
      tabUrl: conversationUrl,
      created: true,
      finalize,
    } as unknown as OpenBrowserUseConnection);
    mocks.prepareOpenBrowserUseConversationRoute.mockRejectedValueOnce(primaryError);

    await expect(harvestSessionBrowserOutput(meta.id, { quietOutput: true })).rejects.toBe(
      primaryError,
    );
    expect(primaryError.message).toContain(signedUrl);
    expect(primaryError.details).toHaveProperty("actualUrl", signedUrl);
    const failedUpdate = mocks.updateSession.mock.calls.at(-1)?.[1] as
      | Partial<SessionMetadata>
      | undefined;
    const operationError = failedUpdate?.browser?.operationErrors?.harvest;
    expect(operationError).toMatchObject({
      message: "Scope changed at [redacted-url]",
      details: {
        stage: "chatgpt-scope",
        code: "scope-mismatch",
        sessionStatus: "needs_login",
        recoveryHandle: {
          transport: "obu",
          sessionId: "recovered-session",
          tabId: 8,
          conversationUrl: "[redacted-url]",
        },
        cleanupFailure: {
          message: "Cleanup failed at [redacted-url]",
          details: {
            stage: "open-browser-use",
            code: "tab-finalize-failed",
            recoveryHandle: {
              transport: "obu",
              sessionId: "cleanup-session",
              tabId: 9,
              conversationUrl: "[redacted-url]",
            },
          },
        },
        oracleOperation: "harvest",
      },
    });
    expect(operationError?.details).not.toHaveProperty("actualUrl");
    const persistedPatch = JSON.stringify(operationError);
    expect(persistedPatch).not.toContain(signedUrl);
    expect(persistedPatch).not.toContain("signature=secret");
    expect(finalize).toHaveBeenCalledWith(false);
  });

  test("accepts a canonical project slug suffix change during harvest", async () => {
    const meta = obuSession();
    const expectedUrl = "https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdef/c/obu-thread";
    meta.browser!.runtime!.tabUrl = expectedUrl;
    const finalize = vi.fn(async (_keepTab: boolean) => {});
    mocks.readSession.mockResolvedValue(meta);
    mocks.connectOpenBrowserUseTab.mockResolvedValue({
      client: {},
      obuClient: {},
      sessionId: "recovered-session",
      tabId: 8,
      tabUrl: expectedUrl,
      created: true,
      finalize,
    } as unknown as OpenBrowserUseConnection);
    mocks.harvestConnectedChatGptTab.mockResolvedValueOnce({
      ...harvested,
      url: "https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdef-oracle/c/obu-thread",
    });

    await expect(
      harvestSessionBrowserOutput(meta.id, { quietOutput: true }),
    ).resolves.toMatchObject({ conversationId: "obu-thread" });
    expect(finalize).toHaveBeenCalledWith(false);
  });

  test("rejects a non-delimited project slug suffix during harvest", async () => {
    const meta = obuSession();
    const expectedUrl = "https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdef/c/obu-thread";
    meta.browser!.runtime!.tabUrl = expectedUrl;
    const finalize = vi.fn(async (_keepTab: boolean) => {});
    mocks.readSession.mockResolvedValue(meta);
    mocks.connectOpenBrowserUseTab.mockResolvedValue({
      client: {},
      obuClient: {},
      sessionId: "recovered-session",
      tabId: 8,
      tabUrl: expectedUrl,
      created: true,
      finalize,
    } as unknown as OpenBrowserUseConnection);
    mocks.harvestConnectedChatGptTab.mockResolvedValueOnce({
      ...harvested,
      url: "https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdefZ/c/obu-thread",
    });

    await expect(harvestSessionBrowserOutput(meta.id, { quietOutput: true })).rejects.toMatchObject(
      { details: { stage: "chatgpt-scope", code: "scope-mismatch" } },
    );
    expect(finalize).toHaveBeenCalledWith(true);
  });

  test("does not start another affinity harvest after the recovery deadline", async () => {
    vi.useFakeTimers();
    try {
      const meta = obuSession();
      meta.browser!.config = { ...meta.browser!.config!, inputTimeoutMs: 1 };
      meta.options.browserConfig = { ...meta.options.browserConfig!, inputTimeoutMs: 1 };
      const finalize = vi.fn(async (_keepTab: boolean) => {});
      mocks.readSession.mockResolvedValue(meta);
      mocks.connectOpenBrowserUseTab.mockResolvedValue({
        client: {},
        obuClient: {},
        sessionId: "recovered-session",
        tabId: 8,
        tabUrl: conversationUrl,
        created: true,
        finalize,
      } as unknown as OpenBrowserUseConnection);
      const missing = new BrowserAutomationError("Stored turn is not hydrated yet.", {
        stage: "chatgpt-turn-affinity",
        code: "turn-affinity-missing",
      });
      mocks.harvestConnectedChatGptTab
        .mockRejectedValueOnce(missing)
        .mockResolvedValueOnce(harvested);

      const result = harvestSessionBrowserOutput(meta.id, { quietOutput: true });
      const rejection = expect(result).rejects.toBe(missing);
      await vi.runAllTimersAsync();
      await rejection;
      expect(mocks.harvestConnectedChatGptTab).toHaveBeenCalledTimes(1);
      expect(finalize).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds an in-flight affinity harvest by the recovery deadline", async () => {
    vi.useFakeTimers();
    try {
      const meta = obuSession();
      meta.browser!.config = { ...meta.browser!.config!, inputTimeoutMs: 1_000 };
      meta.options.browserConfig = { ...meta.options.browserConfig!, inputTimeoutMs: 1_000 };
      const finalize = vi.fn(async (_keepTab: boolean) => {});
      mocks.readSession.mockResolvedValue(meta);
      mocks.connectOpenBrowserUseTab.mockResolvedValue({
        client: {},
        obuClient: {},
        sessionId: "recovered-session",
        tabId: 8,
        tabUrl: conversationUrl,
        created: true,
        finalize,
      } as unknown as OpenBrowserUseConnection);
      mocks.harvestConnectedChatGptTab.mockImplementationOnce(
        () => new Promise<ChatGptTabSummary>(() => {}),
      );

      const result = harvestSessionBrowserOutput(meta.id, { quietOutput: true });
      const rejection = expect(result).rejects.toMatchObject({
        details: { stage: "assistant-timeout", code: "recovered-content-unavailable" },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(mocks.harvestConnectedChatGptTab).toHaveBeenCalledTimes(1);
      expect(finalize).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects a ready harvest that settles at the recovery deadline", async () => {
    vi.useFakeTimers();
    try {
      const meta = obuSession();
      meta.browser!.config = { ...meta.browser!.config!, inputTimeoutMs: 1_000 };
      meta.options.browserConfig = { ...meta.options.browserConfig!, inputTimeoutMs: 1_000 };
      const finalize = vi.fn(async (_keepTab: boolean) => {});
      mocks.readSession.mockResolvedValue(meta);
      mocks.connectOpenBrowserUseTab.mockResolvedValue({
        client: {},
        obuClient: {},
        sessionId: "recovered-session",
        tabId: 8,
        tabUrl: conversationUrl,
        created: true,
        finalize,
      } as unknown as OpenBrowserUseConnection);
      mocks.harvestConnectedChatGptTab.mockImplementationOnce(
        () =>
          new Promise<ChatGptTabSummary>((resolve) => {
            setTimeout(() => resolve(harvested), 1_000);
          }),
      );

      const result = harvestSessionBrowserOutput(meta.id, { quietOutput: true });
      const rejection = expect(result).rejects.toMatchObject({
        details: { stage: "assistant-timeout", code: "recovered-content-unavailable" },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(finalize).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("recovers a delayed conversation URL only from the exact stored tab", async () => {
    const meta = obuSession();
    delete meta.browser?.runtime?.tabUrl;
    delete meta.browser?.runtime?.conversationId;
    const finalize = vi.fn(async (_keepTab: boolean) => {});
    mocks.readSession.mockResolvedValue(meta);
    mocks.connectOpenBrowserUseTab.mockResolvedValue({
      client: {},
      obuClient: {},
      sessionId: "stored-session",
      tabId: 7,
      created: false,
      finalize,
    } as unknown as OpenBrowserUseConnection);

    await expect(
      harvestSessionBrowserOutput(meta.id, { quietOutput: true }),
    ).resolves.toMatchObject({ conversationId: "obu-thread" });

    expect(mocks.connectOpenBrowserUseTab).toHaveBeenCalledWith(
      expect.objectContaining({
        obuSessionId: "stored-session",
        obuTabId: 7,
        exactTabOnly: true,
        conversationUrl: null,
      }),
    );
    expect(mocks.waitForOpenBrowserUseConversationUrl).toHaveBeenCalledWith(
      expect.objectContaining({ connection: expect.objectContaining({ tabId: 7 }) }),
    );
    expect(mocks.prepareOpenBrowserUseConversationRoute).toHaveBeenCalledWith(
      expect.objectContaining({ targetUrl: conversationUrl }),
    );
    expect(meta.browser?.runtime).toMatchObject({
      obuSessionId: "stored-session",
      obuTabId: 7,
      tabUrl: conversationUrl,
      conversationId: "obu-thread",
    });
  });

  test("rejects a latest answer that belongs to another session prompt", async () => {
    const meta = obuSession();
    meta.promptPreview = "parent prompt";
    const finalize = vi.fn(async (_keepTab: boolean) => {});
    mocks.readSession.mockResolvedValue(meta);
    mocks.connectOpenBrowserUseTab.mockResolvedValue({
      client: {},
      obuClient: {},
      sessionId: "stored-session",
      tabId: 7,
      tabUrl: conversationUrl,
      created: false,
      finalize,
    } as unknown as OpenBrowserUseConnection);
    mocks.harvestConnectedChatGptTab.mockResolvedValue({
      ...harvested,
      lastUserText: "child prompt",
      lastUserSnippet: "child prompt",
    });

    await expect(harvestSessionBrowserOutput(meta.id, { quietOutput: true })).rejects.toMatchObject(
      {
        details: { stage: "chatgpt-turn-affinity", code: "turn-affinity-mismatch" },
      },
    );
    expect(finalize).toHaveBeenCalledWith(true);
  });

  test("preserves the primary harvest error and redacts finalization warning details", async () => {
    const meta = obuSession();
    meta.promptPreview = "parent prompt";
    const signedUrl = "https://chatgpt.com/c/cleanup-thread?sig=warning-secret#done";
    const finalize = vi.fn(async () => {
      throw new BrowserAutomationError(`Finalize failed at ${signedUrl}`, {
        stage: "open-browser-use",
        code: "tab-finalize-failed",
        recoveryHandle: {
          transport: "obu",
          sessionId: "stored-session",
          tabId: 7,
          conversationUrl: signedUrl,
        },
      });
    });
    mocks.readSession.mockResolvedValue(meta);
    mocks.connectOpenBrowserUseTab.mockResolvedValue({
      client: {},
      obuClient: {},
      sessionId: "stored-session",
      tabId: 7,
      tabUrl: conversationUrl,
      created: false,
      finalize,
    } as unknown as OpenBrowserUseConnection);
    mocks.harvestConnectedChatGptTab.mockResolvedValue({
      ...harvested,
      lastUserText: "child prompt",
      lastUserSnippet: "child prompt",
    });

    await expect(harvestSessionBrowserOutput(meta.id, { quietOutput: true })).rejects.toMatchObject(
      {
        details: { stage: "chatgpt-turn-affinity", code: "turn-affinity-mismatch" },
      },
    );
    expect(finalize).toHaveBeenCalledWith(true);
    expect(meta.browser?.warnings).toEqual([
      {
        code: "obu-tab-finalize-failed",
        severity: "warning",
        message: "Finalize failed at [redacted-url]",
        details: {
          stage: "open-browser-use",
          code: "tab-finalize-failed",
          recoveryHandle: {
            transport: "obu",
            sessionId: "stored-session",
            tabId: 7,
            conversationUrl: "[redacted-url]",
          },
        },
      },
    ]);
    expect(JSON.stringify(meta.browser?.warnings)).not.toContain(signedUrl);
    expect(JSON.stringify(meta.browser?.warnings)).not.toContain("warning-secret");
    expect(meta.browser?.operationErrors?.harvest?.details).toMatchObject({
      oracleOperation: "harvest",
    });
  });
});
