import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildTabInspectionExpressionForTest,
  classifyTabState,
  connectToExistingChatGptTab,
  extractConversationIdFromUrl,
  expectedConversationIdForRef,
  formatBrowserTabState,
  isChatGptUrl,
  resolveChatGptTab,
  resolveExactChatGptTargetForTest,
  resolveChatGptTabFromSummariesForTest,
  sessionMatchesTab,
  summaryFromTargetForTest,
  type ChatGptTabSummary,
  type ChromeTarget,
} from "../../src/browser/liveTabs.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

const remoteChromeMocks = vi.hoisted(() => ({
  connectToRemoteChromeTarget: vi.fn(),
  listRemoteChromeTargets: vi.fn(),
}));

vi.mock("../../src/browser/chromeLifecycle.js", () => remoteChromeMocks);

beforeEach(() => {
  remoteChromeMocks.connectToRemoteChromeTarget.mockReset();
  remoteChromeMocks.listRemoteChromeTargets.mockReset();
});

function makeTab(overrides: Partial<ChatGptTabSummary> = {}): ChatGptTabSummary {
  return {
    targetId: "target-1",
    title: "ChatGPT",
    url: "https://chatgpt.com/c/abc",
    currentModelLabel: "ChatGPT + Pro",
    stopExists: false,
    sendExists: true,
    promptReady: true,
    loginButtonExists: false,
    authenticated: true,
    assistantCount: 1,
    lastAssistantText: "Answer",
    assistantFollowsLatestUser: true,
    lastAssistantTurnIndex: 1,
    lastUserTurnIndex: 0,
    lastAssistantSnippet: "Answer",
    lastUserText: "Question",
    lastUserSnippet: "Question",
    focused: true,
    visibilityState: "visible",
    conversationId: "abc",
    fingerprint: "fp",
    state: "completed",
    lastAssistantMarkdown: "Answer",
    ...overrides,
  };
}
function makeRemoteTabConnection(
  targetId: string | undefined,
  info: { title: string; url: string; focused: boolean },
  browserWSEndpoint: string | undefined,
  currentUrl = info.url,
) {
  const close = vi.fn(async () => undefined);
  const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
    if (expression.startsWith('typeof location === "object"')) {
      return { result: { value: currentUrl } };
    }
    if (expression.includes("assistantCandidates.reduce")) {
      return {
        result: {
          value: {
            ...info,
            currentModelLabel: "ChatGPT + Pro",
            stopExists: false,
            sendExists: true,
            promptReady: true,
            loginButtonExists: false,
            authenticated: true,
            assistantCount: 1,
            lastAssistantText: "Answer",
            assistantFollowsLatestUser: true,
            lastAssistantTurnIndex: 1,
            lastUserTurnIndex: 0,
            lastUserText: "Question",
            visibilityState: "visible",
          },
        },
      };
    }
    return { result: { value: null } };
  });
  return {
    client: { Runtime: { evaluate } },
    targetId,
    browserWSEndpoint,
    close,
  };
}

describe("liveTabs helpers", () => {
  test("excludes fallback answer nodes contained by the latest user turn", () => {
    const expression = buildTabInspectionExpressionForTest();
    expect(expression).toContain("!lastUserTurn.contains?.(node)");
    expect(expression).toContain("!node.contains?.(lastUserTurn)");
    expect(expression).toContain("assistantCandidates.reduce");
  });
  test("guards the expected conversation inside the inspection expression", () => {
    const expression = buildTabInspectionExpressionForTest("conv-123");
    expect(expression).toContain('const EXPECTED_CONVERSATION_ID = "conv-123"');
    expect(expression).toContain("scopeMismatch");
    expect(expression.indexOf("scopeMismatch")).toBeLessThan(
      expression.indexOf("document.querySelector"),
    );
  });
  test.each([
    "https://chatgpt.com/",
    "https://chat.openai.com/",
    "https://chatgpt.com/g/g-project/project",
    "https://chatgpt.com/g/g-project/project/c/abc-123",
    "https://chat.openai.com/c/abc-123?model=pro#answer",
  ])("accepts exact ChatGPT root, project, and conversation URL %s", (url) => {
    expect(isChatGptUrl(url)).toBe(true);
  });

  test.each([
    "not a URL",
    "http://chatgpt.com/c/a",
    "https://chatgpt.com.evil.example/c/a",
    "https://chat.openai.com.evil.example/c/a",
    "https://sub.chatgpt.com/c/a",
    "https://chatgpt.com@evil.example/c/a",
    "https://evil.example@chatgpt.com/c/a",
    "https://chatgpt.com:443/c/a",
    "https://chatgpt.com:8443/c/a",
    "https://chatgpt.com./c/a",
    "https://constructor/c/a",
  ])("rejects malformed or spoofed ChatGPT URL %s", (url) => {
    expect(isChatGptUrl(url)).toBe(false);
    expect(extractConversationIdFromUrl(url)).toBeUndefined();
  });

  test("rejects title-only decoys during target and summary resolution", () => {
    const decoyTarget: ChromeTarget = {
      id: "decoy",
      type: "page",
      title: "ChatGPT — Review A",
      url: "https://evil.example/c/a",
    };
    expect(resolveExactChatGptTargetForTest([decoyTarget], "decoy")).toBeNull();
    expect(() =>
      resolveChatGptTabFromSummariesForTest(
        [makeTab({ targetId: "decoy", title: "ChatGPT — Review A", url: decoyTarget.url ?? "" })],
        "Review A",
      ),
    ).toThrow(/No live ChatGPT tabs found/i);
  });

  test("classifies running/completed/detached states", () => {
    expect(
      classifyTabState({
        authenticated: true,
        stopExists: true,
        sendExists: false,
        promptReady: false,
        assistantCount: 0,
      }),
    ).toBe("running");
    expect(
      classifyTabState({
        authenticated: true,
        stopExists: false,
        sendExists: true,
        promptReady: true,
        assistantCount: 1,
      }),
    ).toBe("completed");
    expect(
      classifyTabState({
        authenticated: false,
        stopExists: false,
        sendExists: false,
        promptReady: false,
        assistantCount: 0,
      }),
    ).toBe("detached");
  });

  test("formats the stored state when present", () => {
    expect(formatBrowserTabState(makeTab({ state: "stalled" }))).toBe("stalled");
  });

  test("resolves current/id/url/conversation/title refs against live tabs", () => {
    const tabs = [
      makeTab({
        targetId: "target-1",
        title: "Review A",
        url: "https://chatgpt.com/c/a",
        conversationId: "a",
      }),
      makeTab({
        targetId: "target-2",
        title: "Review B",
        url: "https://chatgpt.com/c/b",
        conversationId: "b",
      }),
    ];
    expect(resolveChatGptTabFromSummariesForTest(tabs, "current").targetId).toBe("target-1");
    expect(resolveChatGptTabFromSummariesForTest(tabs, "target-2").url).toBe(
      "https://chatgpt.com/c/b",
    );
    expect(resolveChatGptTabFromSummariesForTest(tabs, "https://chatgpt.com/c/a").targetId).toBe(
      "target-1",
    );
    expect(
      resolveChatGptTabFromSummariesForTest(tabs, "https://chatgpt.com/g/g-project/c/a").targetId,
    ).toBe("target-1");
    expect(resolveChatGptTabFromSummariesForTest(tabs, "b").targetId).toBe("target-2");
    expect(resolveChatGptTabFromSummariesForTest(tabs, "Review B").targetId).toBe("target-2");
  });

  test.each([
    [undefined, "a"],
    ["current", "a"],
    ["target-1", "a"],
    ["Review A", "a"],
    ["a", "a"],
    ["https://chatgpt.com/c/a", "a"],
  ])("pins the selected conversation for the %s reference", (ref, expected) => {
    expect(
      expectedConversationIdForRef(ref, {
        targetId: "target-1",
        title: "Review A",
        url: "https://chatgpt.com/c/a",
        conversationId: "a",
      } as never),
    ).toBe(expected);
  });

  test("leaves an actual root/new-chat target unpinned", () => {
    expect(
      expectedConversationIdForRef("current", {
        targetId: "target-1",
        url: "https://chatgpt.com/",
      }),
    ).toBeUndefined();
  });

  test("resolves exact target ids and urls from target list before inspecting tabs", () => {
    const targets: ChromeTarget[] = [
      { id: "target-1", type: "page", title: "Review A", url: "https://chatgpt.com/c/a" },
      { id: "target-2", type: "page", title: "Review B", url: "https://chatgpt.com/c/b" },
    ];
    expect(resolveExactChatGptTargetForTest(targets, "target-2")?.id).toBe("target-2");
    expect(resolveExactChatGptTargetForTest(targets, "https://chatgpt.com/c/a")?.id).toBe(
      "target-1",
    );
    expect(
      resolveExactChatGptTargetForTest(targets, "https://chatgpt.com/g/g-project/c/a")?.id,
    ).toBe("target-1");
    expect(resolveExactChatGptTargetForTest(targets, "a")?.id).toBe("target-1");
    expect(resolveExactChatGptTargetForTest(targets, "current")).toBeNull();
    expect(resolveExactChatGptTargetForTest(targets, "Review B")).toBeNull();
  });

  test("rejects a full-URL ref before inspecting a retargeted same-origin tab", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9222/devtools/browser/browser-a";
    const close = vi.fn(async () => undefined);
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.startsWith('typeof location === "object"')) {
        return { result: { value: "https://chatgpt.com/c/b" } };
      }
      throw new Error("ChatGPT DOM inspection must not run after a conversation retarget.");
    });
    remoteChromeMocks.listRemoteChromeTargets.mockResolvedValue([
      { targetId: "target-1", type: "page", url: "https://chatgpt.com/c/a" },
    ]);
    remoteChromeMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: { Runtime: { evaluate } },
      targetId: "target-1",
      browserWSEndpoint,
      close,
    });

    await expect(
      resolveChatGptTab({
        host: "127.0.0.1",
        port: 9222,
        browserWSEndpoint,
        ref: "https://chatgpt.com/c/a",
      }),
    ).rejects.toThrow(/conversation changed before live tab inspection/i);

    expect(evaluate).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  test("rejects a full-URL ref retargeted during ChatGPT DOM inspection", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9222/devtools/browser/browser-a";
    const close = vi.fn(async () => undefined);
    let locationCheck = 0;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.startsWith('typeof location === "object"')) {
        locationCheck += 1;
        return {
          result: {
            value: locationCheck === 1 ? "https://chatgpt.com/c/a" : "https://chatgpt.com/c/b",
          },
        };
      }
      if (expression.includes("assistantCandidates.reduce")) {
        return {
          result: {
            value: {
              title: "Review A",
              url: "https://chatgpt.com/c/a",
              currentModelLabel: "ChatGPT + Pro",
              stopExists: false,
              sendExists: true,
              promptReady: true,
              loginButtonExists: false,
              authenticated: true,
              assistantCount: 1,
              lastAssistantText: "Answer",
              assistantFollowsLatestUser: true,
              lastAssistantTurnIndex: 1,
              lastUserTurnIndex: 0,
              lastUserText: "Question",
              visibilityState: "visible",
              focused: true,
            },
          },
        };
      }
      return { result: { value: null } };
    });
    remoteChromeMocks.listRemoteChromeTargets.mockResolvedValue([
      { targetId: "target-1", type: "page", url: "https://chatgpt.com/c/a" },
    ]);
    remoteChromeMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: { Runtime: { evaluate } },
      targetId: "target-1",
      browserWSEndpoint,
      close,
    });

    await expect(
      resolveChatGptTab({
        host: "127.0.0.1",
        port: 9222,
        browserWSEndpoint,
        ref: "https://chatgpt.com/c/a",
      }),
    ).rejects.toThrow(/conversation changed before live tab inspection snapshot/i);

    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        expression: expect.stringContaining("assistantCandidates.reduce"),
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });
  test.each([
    { ref: "current", expectedTargetId: "target-2" },
    { ref: "Review A", expectedTargetId: "target-1" },
    { ref: "https://chatgpt.com/g/g-project/c/a", expectedTargetId: "target-1" },
  ])(
    "inspects and attaches $ref through the exact browser socket",
    async ({ ref, expectedTargetId }) => {
      const browserWSEndpoint = "ws://127.0.0.1:9222/devtools/browser/browser-a";
      const tabInfo = {
        "target-1": {
          title: "Review A",
          url: "https://chatgpt.com/c/a",
          focused: false,
        },
        "target-2": {
          title: "Review B",
          url: "https://chatgpt.com/c/b",
          focused: true,
        },
      } as const;
      remoteChromeMocks.listRemoteChromeTargets.mockResolvedValue([
        { targetId: "target-1", type: "page", url: tabInfo["target-1"].url },
        { targetId: "target-2", type: "page", url: tabInfo["target-2"].url },
      ]);
      remoteChromeMocks.connectToRemoteChromeTarget.mockImplementation(
        async (
          _host: string,
          _port: number,
          _logger: unknown,
          options: { browserWSEndpoint?: string; targetId?: string },
        ) =>
          makeRemoteTabConnection(
            options.targetId,
            tabInfo[options.targetId as keyof typeof tabInfo],
            options.browserWSEndpoint,
          ),
      );

      const result = await connectToExistingChatGptTab({
        host: "127.0.0.1",
        port: 9222,
        browserWSEndpoint,
        ref,
      });

      expect(remoteChromeMocks.listRemoteChromeTargets).toHaveBeenCalledWith({
        host: "127.0.0.1",
        port: 9222,
        browserWSEndpoint,
      });
      expect(result.targetId).toBe(expectedTargetId);
      expect(result.tab.title).toBe(tabInfo[expectedTargetId as keyof typeof tabInfo].title);
      expect(
        remoteChromeMocks.connectToRemoteChromeTarget.mock.calls.every(
          ([, , , options]) => options.browserWSEndpoint === browserWSEndpoint,
        ),
      ).toBe(true);
      expect(remoteChromeMocks.connectToRemoteChromeTarget.mock.lastCall?.[3]?.targetId).toBe(
        expectedTargetId,
      );
      await result.client.close();
    },
  );

  test("rebinds a verified browser tab without requiring an account digest", async () => {
    const freshBrowserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const info = { title: "Review A", url: "https://chatgpt.com/c/a", focused: true };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: freshBrowserWSEndpoint }),
      }),
    );
    remoteChromeMocks.listRemoteChromeTargets.mockResolvedValue([
      { targetId: "target-1", type: "page", url: info.url },
    ]);
    remoteChromeMocks.connectToRemoteChromeTarget.mockImplementation(
      async (
        _host: string,
        _port: number,
        _logger: unknown,
        options: { browserWSEndpoint?: string; targetId?: string },
      ) => makeRemoteTabConnection(options.targetId, info, options.browserWSEndpoint),
    );
    try {
      const result = await connectToExistingChatGptTab({
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        browserWSEndpoint: "ws://stale.invalid/devtools/browser/browser-a",
        ref: "target-1",
      });

      expect(result.targetId).toBe("target-1");
      expect(remoteChromeMocks.listRemoteChromeTargets).toHaveBeenCalledWith({
        host: "127.0.0.1",
        port: 9223,
        browserWSEndpoint: freshBrowserWSEndpoint,
      });
      expect(
        remoteChromeMocks.connectToRemoteChromeTarget.mock.calls.every(
          ([, , , options]) => options.browserWSEndpoint === freshBrowserWSEndpoint,
        ),
      ).toBe(true);
      await result.client.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("fails closed when a selected ChatGPT target redirects before connection use", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9222/devtools/browser/browser-a";
    const info = { title: "Review A", url: "https://chatgpt.com/c/a", focused: true };
    const inspected = makeRemoteTabConnection("target-1", info, browserWSEndpoint);
    const redirected = makeRemoteTabConnection(
      "target-1",
      info,
      browserWSEndpoint,
      "https://evil.example/phish",
    );
    remoteChromeMocks.listRemoteChromeTargets.mockResolvedValue([
      { targetId: "target-1", type: "page", url: info.url },
    ]);
    remoteChromeMocks.connectToRemoteChromeTarget
      .mockResolvedValueOnce(inspected)
      .mockResolvedValueOnce(redirected);

    await expect(
      connectToExistingChatGptTab({
        host: "127.0.0.1",
        port: 9222,
        browserWSEndpoint,
        ref: "target-1",
      }),
    ).rejects.toThrow(/allowed HTTPS origin/i);
    expect(redirected.close).toHaveBeenCalledOnce();
  });

  test.each([
    { ref: "a", currentUrl: "https://chatgpt.com/" },
    { ref: "https://chatgpt.com/c/a", currentUrl: "https://chatgpt.com/c/b" },
  ])(
    "rejects same-origin revalidation when $ref no longer identifies the selected conversation",
    async ({ ref, currentUrl }) => {
      const browserWSEndpoint = "ws://127.0.0.1:9222/devtools/browser/browser-a";
      const info = { title: "Review A", url: "https://chatgpt.com/c/a", focused: true };
      const inspected = makeRemoteTabConnection("target-1", info, browserWSEndpoint);
      const revalidated = makeRemoteTabConnection("target-1", info, browserWSEndpoint, currentUrl);
      remoteChromeMocks.listRemoteChromeTargets.mockResolvedValue([
        { targetId: "target-1", type: "page", url: info.url },
      ]);
      remoteChromeMocks.connectToRemoteChromeTarget
        .mockResolvedValueOnce(inspected)
        .mockResolvedValueOnce(revalidated);

      await expect(
        connectToExistingChatGptTab({
          host: "127.0.0.1",
          port: 9222,
          browserWSEndpoint,
          ref,
        }),
      ).rejects.toThrow(/ChatGPT conversation changed before existing-tab connection/i);

      expect(revalidated.close).toHaveBeenCalledOnce();
    },
  );

  test("rejects a restarted browser before inspecting a bound live tab", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/browser-b",
        }),
      }),
    );
    try {
      await expect(
        connectToExistingChatGptTab({
          host: "127.0.0.1",
          port: 9223,
          browserId: "browser-a",
          browserWSEndpoint: "ws://stale.invalid/devtools/browser/browser-a",
          ref: "target-1",
        }),
      ).rejects.toThrow(/browser identity changed before live tab inspection/i);
      expect(remoteChromeMocks.listRemoteChromeTargets).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("uses the fresh browser WebSocket and rejects an account swap", async () => {
    const freshBrowserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: freshBrowserWSEndpoint }),
      }),
    );
    remoteChromeMocks.listRemoteChromeTargets.mockResolvedValue([
      { targetId: "target-1", type: "page", url: "https://chatgpt.com/c/a" },
    ]);
    remoteChromeMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: {
        Runtime: {
          evaluate: vi.fn(async ({ expression }: { expression: string }) => {
            if (expression.startsWith('typeof location === "object"')) {
              return { result: { value: "https://chatgpt.com/c/a" } };
            }
            return {
              result: { value: expression.includes("/api/auth/session") ? "b".repeat(64) : null },
            };
          }),
        },
      },
      targetId: "target-1",
      browserWSEndpoint: freshBrowserWSEndpoint,
      close: vi.fn(async () => undefined),
    });
    try {
      await expect(
        connectToExistingChatGptTab({
          host: "127.0.0.1",
          port: 9223,
          browserId: "browser-a",
          browserWSEndpoint: "ws://stale.invalid/devtools/browser/browser-a",
          accountDigest: "a".repeat(64),
          ref: "current",
        }),
      ).rejects.toThrow(/account identity changed before live tab inspection/i);
      expect(remoteChromeMocks.listRemoteChromeTargets).toHaveBeenCalledWith({
        host: "127.0.0.1",
        port: 9223,
        browserWSEndpoint: freshBrowserWSEndpoint,
      });
      expect(remoteChromeMocks.connectToRemoteChromeTarget).toHaveBeenCalledWith(
        "127.0.0.1",
        9223,
        expect.any(Function),
        expect.objectContaining({ browserWSEndpoint: freshBrowserWSEndpoint }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("fails closed when a bound account probe cannot complete", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    remoteChromeMocks.listRemoteChromeTargets.mockResolvedValue([
      { targetId: "target-1", type: "page", url: "https://chatgpt.com/c/a" },
    ]);
    remoteChromeMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: {
        Runtime: {
          evaluate: vi.fn(async ({ expression }: { expression: string }) => {
            if (expression.startsWith('typeof location === "object"')) {
              return { result: { value: "https://chatgpt.com/c/a" } };
            }
            throw new Error("CDP context destroyed");
          }),
        },
      },
      targetId: "target-1",
      browserWSEndpoint,
      close: vi.fn(async () => undefined),
    });
    try {
      await expect(
        connectToExistingChatGptTab({
          host: "127.0.0.1",
          port: 9223,
          browserId: "browser-a",
          browserWSEndpoint,
          accountDigest: "a".repeat(64),
          ref: "current",
        }),
      ).rejects.toThrow(/CDP context destroyed/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("builds enough summary from exact targets for export scope checks", () => {
    const summary = summaryFromTargetForTest("127.0.0.1", 9222, {
      id: "target-1",
      type: "page",
      title: "Review A",
      url: "https://chatgpt.com/g/project/c/conv-1",
    });
    expect(summary.targetId).toBe("target-1");
    expect(summary.url).toBe("https://chatgpt.com/g/project/c/conv-1");
    expect(summary.conversationId).toBe("conv-1");
    expect(summary.fingerprint).toBeTruthy();
  });

  test("throws on ambiguous title matches", () => {
    const tabs = [
      makeTab({ targetId: "target-1", title: "Routing Review", url: "https://chatgpt.com/c/a" }),
      makeTab({
        targetId: "target-2",
        title: "Routing Review Followup",
        url: "https://chatgpt.com/c/b",
      }),
    ];
    expect(() => resolveChatGptTabFromSummariesForTest(tabs, "Routing Review")).toThrow(
      /Multiple ChatGPT tabs match/i,
    );
  });

  test("matches sessions by target id, url, and conversation id", () => {
    const meta = {
      id: "session-1",
      createdAt: "2026-03-27T00:00:00.000Z",
      status: "completed",
      options: {},
      mode: "browser",
      browser: {
        runtime: {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeTargetId: "target-1",
          tabUrl: "https://chatgpt.com/c/abc",
          conversationId: "abc",
        },
      },
    } as SessionMetadata;
    expect(
      sessionMatchesTab(meta, {
        host: "127.0.0.1",
        port: 9222,
        targetId: "target-1",
        url: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      }),
    ).toBe(true);
    expect(
      sessionMatchesTab(meta, {
        host: "127.0.0.1",
        port: 9222,
        targetId: "target-2",
        url: "https://chatgpt.com/c/def",
        conversationId: "def",
      }),
    ).toBe(false);
  });
});
