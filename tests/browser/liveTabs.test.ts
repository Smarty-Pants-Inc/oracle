import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildTabInspectionExpressionForTest,
  classifyTabState,
  connectToExistingChatGptTab,
  formatBrowserTabState,
  harvestConnectedChatGptTab,
  resolveExactChatGptTargetForTest,
  resolveChatGptTabFromSummariesForTest,
  sessionMatchesTab,
  summaryFromTargetForTest,
  type ChatGptTabSummary,
  type ChromeTarget,
} from "../../src/browser/liveTabs.js";
import type { SessionMetadata } from "../../src/sessionStore.js";
import { hashConversationTurnText } from "../../src/browser/conversationTurns.js";
import type { ChromeClient } from "../../src/browser/types.js";

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

describe("liveTabs helpers", () => {
  test("excludes fallback answer nodes contained by the latest user turn", () => {
    const expression = buildTabInspectionExpressionForTest();
    expect(expression).toContain("!lastUserTurn.contains?.(node)");
    expect(expression).toContain("!node.contains?.(lastUserTurn)");
    expect(expression).toContain("assistantCandidates.reduce");
  });
  test("harvests the assistant paired with the stored user turn, not a later child", async () => {
    const parentPrompt = `${"shared prefix ".repeat(20)}parent`;
    const childPrompt = `${"shared prefix ".repeat(20)}child`;
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("assistantCandidates.reduce")) {
          return {
            result: {
              value: {
                title: "ChatGPT",
                url: "https://chatgpt.com/c/abc",
                currentModelLabel: "Pro",
                stopExists: false,
                sendExists: true,
                promptReady: true,
                loginButtonExists: false,
                authenticated: true,
                assistantCount: 2,
                lastAssistantText: "child answer",
                assistantFollowsLatestUser: true,
                lastAssistantTurnIndex: 3,
                lastUserTurnIndex: 2,
                lastUserText: childPrompt,
                visibilityState: "visible",
                focused: false,
              },
            },
          };
        }
        if (expression.includes("return turns.flatMap")) {
          return {
            result: {
              value: [
                { index: 0, text: parentPrompt, turnId: "user-0", messageId: "user-message-0" },
                { index: 2, text: childPrompt, turnId: "user-2", messageId: "user-message-2" },
              ],
            },
          };
        }
        if (expression.includes("const candidates = []")) {
          return {
            result: {
              value: [
                {
                  user: {
                    index: 0,
                    text: parentPrompt,
                    turnId: "user-0",
                    messageId: "user-message-0",
                  },
                  assistants: [
                    {
                      index: 1,
                      text: "parent answer",
                      turnId: "assistant-1",
                      messageId: "assistant-message-1",
                    },
                  ],
                  hasLaterUserTurn: true,
                },
              ],
            },
          };
        }
        if (expression.includes("const BUTTON_SELECTOR")) {
          expect(expression).toContain('"assistant-message-1"');
          return { result: { value: { success: true, markdown: "parent **answer**" } } };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      harvestConnectedChatGptTab({
        client: { Runtime } as unknown as ChromeClient,
        targetId: "target-1",
        turnBinding: {
          promptDigest: hashConversationTurnText(parentPrompt),
          promptTurnIndex: 0,
          promptTurnId: "user-0",
          promptMessageId: "user-message-0",
        },
      }),
    ).resolves.toMatchObject({
      state: "completed",
      lastUserText: parentPrompt,
      lastAssistantText: "parent answer",
      lastAssistantMarkdown: "parent **answer**",
    });
  });

  test("keeps a bound unanswered prompt running despite older completed assistants", async () => {
    const prompt = "exact unanswered prompt";
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("assistantCandidates.reduce")) {
          return {
            result: {
              value: {
                title: "ChatGPT",
                url: "https://chatgpt.com/c/abc",
                currentModelLabel: "Pro",
                stopExists: false,
                sendExists: true,
                promptReady: true,
                loginButtonExists: false,
                authenticated: true,
                assistantCount: 3,
                lastAssistantText: "older completed answer",
                assistantFollowsLatestUser: true,
                lastAssistantTurnIndex: 3,
                lastUserTurnIndex: 4,
                lastUserText: prompt,
                visibilityState: "visible",
                focused: false,
              },
            },
          };
        }
        if (expression.includes("const candidates = []")) {
          return {
            result: {
              value: [
                {
                  user: {
                    index: 4,
                    text: prompt,
                    turnId: "user-4",
                    messageId: "user-message-4",
                  },
                  assistants: [],
                  hasLaterUserTurn: false,
                },
              ],
            },
          };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      harvestConnectedChatGptTab({
        client: { Runtime } as unknown as ChromeClient,
        targetId: "target-1",
        turnBinding: {
          promptDigest: hashConversationTurnText(prompt),
          promptTurnIndex: 4,
          promptTurnId: "user-4",
          promptMessageId: "user-message-4",
        },
      }),
    ).resolves.toMatchObject({
      state: "running",
      lastUserText: prompt,
      lastAssistantText: "",
      lastAssistantMarkdown: null,
    });
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
  test("does not retain an unrelated tab for unpinned root or temporary URL refs", () => {
    const tabs = [
      makeTab({
        targetId: "conversation",
        url: "https://chatgpt.com/c/unrelated",
        conversationId: "unrelated",
      }),
    ];
    expect(() => resolveChatGptTabFromSummariesForTest(tabs, "https://chatgpt.com/")).toThrow(
      /no ChatGPT tab matched/i,
    );
    expect(() =>
      resolveChatGptTabFromSummariesForTest(tabs, "https://chatgpt.com/?temporary-chat=true"),
    ).toThrow(/no ChatGPT tab matched/i);

    const targets: ChromeTarget[] = [
      { id: "conversation", type: "page", url: "https://chatgpt.com/c/unrelated" },
    ];
    expect(resolveExactChatGptTargetForTest(targets, "https://chatgpt.com/")).toBeNull();
    expect(
      resolveExactChatGptTargetForTest(targets, "https://chatgpt.com/?temporary-chat=true"),
    ).toBeNull();
  });

  test("prefers the canonical project scope when duplicate tabs share a conversation id", () => {
    const tabs = [
      makeTab({
        targetId: "root",
        url: "https://chatgpt.com/c/shared",
        conversationId: "shared",
      }),
      makeTab({
        targetId: "project",
        url: "https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdef-oracle/c/shared",
        conversationId: "shared",
      }),
    ];

    expect(
      resolveChatGptTabFromSummariesForTest(
        tabs,
        "https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdef/c/shared",
      ).targetId,
    ).toBe("project");
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
    expect(resolveExactChatGptTargetForTest(targets, "current")).toBeNull();
    expect(resolveExactChatGptTargetForTest(targets, "Review B")).toBeNull();
  });

  test("prefers the canonical project target when duplicate targets share a conversation id", () => {
    const targets: ChromeTarget[] = [
      { id: "root", type: "page", url: "https://chatgpt.com/c/shared" },
      {
        id: "project",
        type: "page",
        url: "https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdef-oracle/c/shared",
      },
    ];

    expect(
      resolveExactChatGptTargetForTest(
        targets,
        "https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdef/c/shared",
      )?.id,
    ).toBe("project");
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
        ) => {
          const info = tabInfo[options.targetId as keyof typeof tabInfo];
          let evaluationCount = 0;
          const close = vi.fn(async () => undefined);
          return {
            client: {
              Runtime: {
                evaluate: vi.fn(async () => {
                  evaluationCount += 1;
                  return evaluationCount === 1 && info
                    ? {
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
                      }
                    : { result: { value: null } };
                }),
              },
            },
            targetId: options.targetId,
            browserWSEndpoint: options.browserWSEndpoint,
            close,
          };
        },
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
          accountDigest: "a".repeat(64),
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
          evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
            result: { value: expression.includes("/api/auth/session") ? "b".repeat(64) : null },
          })),
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
          evaluate: vi.fn().mockRejectedValue(new Error("CDP context destroyed")),
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
