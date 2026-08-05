import { describe, expect, test, vi } from "vitest";
import {
  buildTabInspectionExpressionForTest,
  classifyTabState,
  connectToExistingChatGptTab,
  formatBrowserTabState,
  resolveExactChatGptTargetForTest,
  resolveChatGptTabFromSummariesForTest,
  summaryFromTargetForTest,
  type ChromeTarget,
  sessionMatchesTab,
  type ChatGptTabSummary,
} from "../../src/browser/liveTabs.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

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

function exactBrowserForTabs() {
  const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
    result: {
      value: expression.includes("currentModelLabel")
        ? {
            title: "Existing A",
            url: "https://chatgpt.com/c/a",
            currentModelLabel: "GPT-5.6 Pro",
            stopExists: false,
            sendExists: true,
            promptReady: true,
            loginButtonExists: false,
            authenticated: true,
            assistantCount: 0,
            lastAssistantText: "",
            lastUserText: "",
            visibilityState: "visible",
            focused: true,
          }
        : null,
    },
  }));
  return {
    Target: {
      getTargets: vi.fn(async () => ({
        targetInfos: [
          {
            targetId: "target-a",
            type: "page",
            title: "Existing A",
            url: "https://chatgpt.com/c/a",
          },
        ],
      })),
      attachToTarget: vi.fn(async () => ({ sessionId: "session-a" })),
      detachFromTarget: vi.fn(async () => undefined),
    },
    Runtime: { enable: vi.fn(async () => undefined), evaluate },
    DOM: { enable: vi.fn(async () => undefined) },
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
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
    expect(resolveExactChatGptTargetForTest(targets, "current")).toBeNull();
    expect(resolveExactChatGptTargetForTest(targets, "Review B")).toBeNull();
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

  test("resolves and attaches an existing tab only through generation A authority", async () => {
    const browserA = exactBrowserForTabs();
    const authority = {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/generation-a",
      kill: vi.fn(),
      runExactOperation: vi.fn(async (operation: (client: never) => Promise<unknown>) => ({
        status: "completed" as const,
        value: await operation(browserA as never),
      })),
      release: vi.fn(),
    };

    const connected = await connectToExistingChatGptTab({
      host: "127.0.0.1",
      port: 9222,
      ref: "current",
      endpointAuthority: authority as never,
    });

    expect(connected.targetId).toBe("target-a");
    expect(connected.tab.url).toBe("https://chatgpt.com/c/a");
    expect(browserA.Target.getTargets).toHaveBeenCalledOnce();
    expect(browserA.Target.attachToTarget).toHaveBeenCalledTimes(2);
    await connected.client.close();
    expect(browserA.Target.detachFromTarget).toHaveBeenCalledTimes(2);
  });

  test("attaches an explicit target ref without inspecting any other page", async () => {
    const browserA = exactBrowserForTabs();
    const authority = {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/generation-a",
      kill: vi.fn(),
      runExactOperation: vi.fn(async (operation: (client: never) => Promise<unknown>) => ({
        status: "completed" as const,
        value: await operation(browserA as never),
      })),
      release: vi.fn(),
    };

    const connected = await connectToExistingChatGptTab({
      host: "127.0.0.1",
      port: 9222,
      ref: "target-a",
      endpointAuthority: authority as never,
    });

    expect(connected.targetId).toBe("target-a");
    expect(browserA.Runtime.evaluate).not.toHaveBeenCalled();
    expect(browserA.Target.attachToTarget).toHaveBeenCalledOnce();
  });

  test("does not attach or run page effects on generation B after same-port rebinding", async () => {
    const browserA = exactBrowserForTabs();
    const browserB = exactBrowserForTabs();
    let operationCount = 0;
    const authority = {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/generation-a",
      kill: vi.fn(),
      runExactOperation: vi.fn(async (operation: (client: never) => Promise<unknown>) => {
        operationCount += 1;
        if (operationCount === 1) {
          return { status: "completed" as const, value: await operation(browserA as never) };
        }
        return { status: "gone" as const };
      }),
      release: vi.fn(),
    };

    await expect(
      connectToExistingChatGptTab({
        host: "127.0.0.1",
        port: 9222,
        ref: "current",
        endpointAuthority: authority as never,
      }),
    ).rejects.toThrow(/generation exited/i);
    expect(browserA.Target.getTargets).toHaveBeenCalledOnce();
    expect(browserA.Target.attachToTarget).not.toHaveBeenCalled();
    expect(browserB.Target.getTargets).not.toHaveBeenCalled();
    expect(browserB.Target.attachToTarget).not.toHaveBeenCalled();
    expect(browserB.Runtime.enable).not.toHaveBeenCalled();
    expect(browserB.Runtime.evaluate).not.toHaveBeenCalled();
  });
});
