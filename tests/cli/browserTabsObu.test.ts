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
    vi.clearAllMocks();
    mocks.updateSession.mockResolvedValue(undefined);
    mocks.acquireOpenBrowserUseRunLock.mockResolvedValue({
      path: "/tmp/oracle.lock",
      lockId: "lock-1",
      release: vi.fn(async () => {}),
    });
    mocks.harvestConnectedChatGptTab.mockResolvedValue(harvested);
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

  test("preserves the primary harvest error when tab finalization also fails", async () => {
    const meta = obuSession();
    meta.promptPreview = "parent prompt";
    const finalize = vi.fn(async () => {
      throw new Error("finalize failed");
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
      expect.objectContaining({ code: "obu-tab-finalize-failed", message: "finalize failed" }),
    ]);
    expect(meta.browser?.operationErrors?.harvest?.details).toMatchObject({
      oracleOperation: "harvest",
    });
  });
});
