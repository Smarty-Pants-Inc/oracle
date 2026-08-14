import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildTabInspectionExpressionForTest,
  classifyTabState,
  connectToExistingChatGptTab,
  formatBrowserTabState,
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

describe("liveTabs helpers", () => {
  test("excludes fallback answer nodes contained by the latest user turn", () => {
    const expression = buildTabInspectionExpressionForTest();
    expect(expression).toContain("!lastUserTurn.contains?.(node)");
    expect(expression).toContain("!node.contains?.(lastUserTurn)");
    expect(expression).toContain("assistantCandidates.reduce");
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
