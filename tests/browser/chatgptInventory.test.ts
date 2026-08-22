import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChromeClient } from "../../src/browser/types.js";

const chromeMocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  connectToRemoteChromeTarget: vi.fn(),
}));

vi.mock("../../src/browser/chromeLifecycle.js", () => chromeMocks);

import {
  buildChatGptInventoryAuthCaptureHook,
  buildChatGptInventoryPageExpression,
  captureChatGptConversationInventory,
  paginateChatGptConversationList,
  parseChatGptConversationListPage,
} from "../../src/browser/chatgptInventory.js";

describe("ChatGPT conversation inventory", () => {
  beforeEach(() => {
    chromeMocks.closeTab.mockReset().mockResolvedValue(true);
    chromeMocks.connectToRemoteChromeTarget.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("parses the common list schema and paginates by offset", async () => {
    const offsets: number[] = [];
    const items = await paginateChatGptConversationList(async (offset) => {
      offsets.push(offset);
      return offset === 0
        ? {
            items: [
              { id: "conv-a", title: "A", create_time: 1_700_000_000, update_time: 1_700_000_001 },
              { id: "conv-b", title: "B", create_time: null, update_time: null },
            ],
            total: 3,
            limit: 2,
            offset: 0,
          }
        : {
            items: [
              {
                conversation_id: "conv-c",
                title: "C",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-02T00:00:00.000Z",
              },
            ],
            total: 3,
            limit: 2,
            offset: 2,
          };
    }, false);

    expect(offsets).toEqual([0, 2]);
    expect(items).toEqual([
      {
        conversationId: "conv-a",
        title: "A",
        createdAt: "2023-11-14T22:13:20.000Z",
        updatedAt: "2023-11-14T22:13:21.000Z",
        archived: false,
        url: "https://chatgpt.com/c/conv-a",
      },
      {
        conversationId: "conv-b",
        title: "B",
        createdAt: null,
        updatedAt: null,
        archived: false,
        url: "https://chatgpt.com/c/conv-b",
      },
      {
        conversationId: "conv-c",
        title: "C",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        archived: false,
        url: "https://chatgpt.com/c/conv-c",
      },
    ]);
  });

  test("accepts current ChatGPT rolling pagination totals", async () => {
    const ids = ["conv-a", "conv-b", "conv-c", "conv-d", "conv-e"];
    const offsets: number[] = [];
    const items = await paginateChatGptConversationList(async (offset) => {
      offsets.push(offset);
      const remaining = ids.slice(offset, offset + 2);
      return {
        items: remaining.map((id) => ({ id, title: id })),
        total: offset + remaining.length + (offset + remaining.length < ids.length ? 1 : 0),
        limit: 2,
        offset,
      };
    }, false);

    expect(offsets).toEqual([0, 2, 4]);
    expect(items.map((item) => item.conversationId)).toEqual(ids);
  });

  test("fails clearly on an unexpected list schema", () => {
    expect(() => parseChatGptConversationListPage({ items: [], total: 0 }, true)).toThrow(
      /expected \{items,total,limit,offset\}/i,
    );
    expect(() =>
      parseChatGptConversationListPage(
        { items: [{ title: "missing id" }], total: 1, limit: 1, offset: 0 },
        true,
      ),
    ).toThrow(/item 0 has no conversation id/i);
  });

  test("derives the page deadline from a local remaining-time budget", () => {
    const expression = buildChatGptInventoryPageExpression(false, 0, 100, 1_234);

    expect(expression).toContain("const budgetMs = 1234;");
    expect(expression).toContain("const deadline = Date.now() + budgetMs;");
    expect(expression).not.toContain("const deadline = 1234;");
  });

  test("rejects a restarted browser before opening inventory", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/browser-b",
        }),
      }),
    );

    await expect(
      captureChatGptConversationInventory({
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        browserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
        expectedEmail: "owner@example.test",
      }),
    ).rejects.toThrow(/browser identity changed before ChatGPT inventory/i);
    expect(chromeMocks.connectToRemoteChromeTarget).not.toHaveBeenCalled();
  });

  test("starts the inventory deadline before remote browser identity resolution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<never>(() => undefined)),
    );

    const capture = captureChatGptConversationInventory({
      host: "127.0.0.1",
      port: 9223,
      browserId: "browser-a",
      browserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
      expectedEmail: "owner@example.test",
      timeoutMs: 100,
    });
    const failure = capture.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(100);

    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /timed out while resolving the remote Chrome browser identity/i,
    );
    expect(chromeMocks.connectToRemoteChromeTarget).not.toHaveBeenCalled();
  });

  test("bounds stalled disposable target setup by the inventory deadline", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    let signalTargetConnectionStarted!: () => void;
    const targetConnectionStarted = new Promise<void>((resolve) => {
      signalTargetConnectionStarted = resolve;
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    chromeMocks.connectToRemoteChromeTarget.mockImplementation(() => {
      signalTargetConnectionStarted();
      return new Promise<never>(() => undefined);
    });

    const capture = captureChatGptConversationInventory({
      host: "127.0.0.1",
      port: 9223,
      browserId: "browser-a",
      browserWSEndpoint,
      expectedEmail: "owner@example.test",
      timeoutMs: 100,
    });
    const failure = capture.catch((error: unknown) => error);

    await targetConnectionStarted;
    await vi.advanceTimersByTimeAsync(100);

    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /timed out while opening the disposable ChatGPT inventory target/i,
    );
  });

  test("binds retained authorization before replaying authenticated GET inventory requests", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    const sessionUrl = "https://chatgpt.com/api/auth/session";
    const activeUrl =
      "https://chatgpt.com/backend-api/conversations?offset=0&limit=100&order=updated&is_archived=false";
    const archivedUrl =
      "https://chatgpt.com/backend-api/conversations?offset=0&limit=100&order=updated&is_archived=true";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    const evaluated: string[] = [];
    const lifecycle: string[] = [];
    let inventoryCalls = 0;
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        evaluated.push(expression);
        if (expression.includes("inventory.cleanup")) {
          lifecycle.push("cleanup");
          return { result: { value: true } };
        }
        if (expression.includes("document.readyState")) {
          return {
            result: {
              value: { href: "https://chatgpt.com/", readyState: "complete" },
            },
          };
        }
        if (expression.includes("Boolean(window.__oracleChatGptInventory?.ready)")) {
          return { result: { value: true } };
        }
        if (expression.includes("inventory.readCookieIdentity(")) {
          return {
            result: {
              value: {
                ok: true,
                status: 200,
                url: sessionUrl,
                redirected: false,
                accountDigest,
                email: " OWNER@EXAMPLE.TEST ",
              },
            },
          };
        }
        if (expression.includes("inventory.bindRetainedAuthorization(")) {
          return {
            result: {
              value: {
                ok: true,
                status: 200,
                url: sessionUrl,
                redirected: false,
                accountDigest,
                email: "owner@example.test",
              },
            },
          };
        }
        if (expression.includes("inventory.fetchPage")) {
          inventoryCalls += 1;
          const url = inventoryCalls === 3 ? archivedUrl : activeUrl;
          if (inventoryCalls === 1) {
            return {
              result: {
                value: {
                  ok: false,
                  status: 429,
                  reason: "http",
                  retryAfterMs: 0,
                  url,
                  redirected: false,
                },
              },
            };
          }
          return {
            result: {
              value: {
                ok: true,
                status: 200,
                url,
                redirected: false,
                body: { items: [], total: 0, limit: 100, offset: 0 },
              },
            },
          };
        }
        return { result: { value: undefined } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const Page = {
      enable: vi.fn(async () => undefined),
      addScriptToEvaluateOnNewDocument: vi.fn(async () => ({ identifier: "inventory-hook" })),
      removeScriptToEvaluateOnNewDocument: vi.fn(async () => {
        lifecycle.push("remove-script");
      }),
      navigate: vi.fn(async () => ({ frameId: "inventory-frame" })),
    };
    const close = vi.fn(async () => {
      lifecycle.push("detach");
    });
    chromeMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: { Page, Runtime },
      targetId: "inventory-target",
      browserWSEndpoint,
      close,
    });

    await expect(
      captureChatGptConversationInventory({
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        browserWSEndpoint,
        expectedEmail: "owner@example.test",
      }),
    ).resolves.toEqual({ accountDigest, items: [] });

    expect(chromeMocks.connectToRemoteChromeTarget).toHaveBeenCalledWith(
      "127.0.0.1",
      9223,
      expect.any(Function),
      expect.objectContaining({
        targetUrl: "https://chatgpt.com/",
        browserWSEndpoint,
        closeTargetOnDispose: false,
      }),
    );
    const authCaptureHook = buildChatGptInventoryAuthCaptureHook();
    expect(Page.enable).toHaveBeenCalledOnce();
    expect(Page.addScriptToEvaluateOnNewDocument).toHaveBeenCalledWith({
      source: authCaptureHook,
    });
    expect(Page.navigate).toHaveBeenCalledWith({ url: "https://chatgpt.com/" });
    expect(Page.removeScriptToEvaluateOnNewDocument).toHaveBeenCalledWith({
      identifier: "inventory-hook",
    });
    expect(close).toHaveBeenCalledOnce();
    expect(chromeMocks.closeTab).toHaveBeenCalledWith(
      9223,
      "inventory-target",
      expect.any(Function),
      "127.0.0.1",
    );
    expect(lifecycle.slice(0, 3)).toEqual(["cleanup", "remove-script", "detach"]);
    expect(authCaptureHook).toContain('request.headers.has("authorization")');
    expect(authCaptureHook).toContain('headers.delete("x-openai-target-path")');
    expect(authCaptureHook).toContain('headers.delete("x-openai-target-route")');
    expect(authCaptureHook).toContain("const cookieIdentity = await readIdentity(");
    expect(authCaptureHook).toContain('payload?.["https://api.openai.com/auth"]');
    expect(authCaptureHook).toContain('payload?.["https://api.openai.com/profile"]');
    expect(authCaptureHook).toContain(
      "bearerIdentity.accountDigest !== cookieIdentity.accountDigest",
    );
    expect(authCaptureHook).toContain("bearerIdentity.email !== cookieIdentity.email");
    expect(authCaptureHook).not.toContain('readIdentity(headers, "omit")');
    expect(authCaptureHook).toContain('redirect: "error"');
    expect(authCaptureHook).toContain("url: response.url");
    expect(authCaptureHook).toContain("async readCookieIdentity(deadline)");
    expect(authCaptureHook).toContain("async bindRetainedAuthorization(deadline)");
    expect(authCaptureHook).toContain("const remaining = deadline - Date.now()");
    expect(authCaptureHook).toContain("new AbortController()");
    expect(authCaptureHook).toContain("signal: controller.signal");
    expect(authCaptureHook).toContain('method: "GET"');
    expect(authCaptureHook).toContain('response.headers.get("retry-after")');
    expect(authCaptureHook).not.toMatch(/\b(?:POST|PUT|PATCH|DELETE)\b/);
    const activeExpression = buildChatGptInventoryPageExpression(false, 0, 100);
    expect(activeExpression).toContain("url.searchParams.set('is_archived', \"false\")");
    expect(buildChatGptInventoryPageExpression(true, 0, 100)).toContain(
      "url.searchParams.set('is_archived', \"true\")",
    );
    const bearerIdentityIndex = evaluated.findIndex((expression) =>
      expression.includes("inventory.bindRetainedAuthorization("),
    );
    const inventoryRequestIndex = evaluated.findIndex((expression) =>
      expression.includes("inventory.fetchPage"),
    );
    expect(bearerIdentityIndex).toBeGreaterThan(-1);
    expect(inventoryRequestIndex).toBeGreaterThan(bearerIdentityIndex);
    expect(
      evaluated.filter((expression) => expression.includes("inventory.fetchPage")),
    ).toHaveLength(3);
    expect(inventoryCalls).toBe(3);
    const pageBudgets = evaluated
      .filter((expression) => expression.includes("inventory.fetchPage"))
      .map((expression) => /const budgetMs = (\d+);/.exec(expression)?.[1]);
    expect(pageBudgets).not.toContain(undefined);
    expect(pageBudgets.every((budget) => Number(budget) > 0)).toBe(true);
    expect(
      evaluated
        .filter((expression) => expression.includes("inventory.fetchPage"))
        .every((expression) => expression.includes("const deadline = Date.now() + budgetMs;")),
    ).toBe(true);
    expect(evaluated.join("\n")).not.toMatch(/\b(?:POST|PUT|PATCH|DELETE)\b/);

    inventoryCalls = 0;
    chromeMocks.closeTab.mockResolvedValueOnce(false);
    await expect(
      captureChatGptConversationInventory({
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        browserWSEndpoint,
        expectedEmail: "owner@example.test",
      }),
    ).rejects.toThrow(/target cleanup was not confirmed/i);
  });

  test("keeps every fallback retry reachable with the default inventory timeout", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    const activeUrl =
      "https://chatgpt.com/backend-api/conversations?offset=0&limit=100&order=updated&is_archived=false";
    const archivedUrl =
      "https://chatgpt.com/backend-api/conversations?offset=0&limit=100&order=updated&is_archived=true";
    let activeAttempts = 0;
    let signalFirstPage!: () => void;
    const firstPage = new Promise<void>((resolve) => {
      signalFirstPage = resolve;
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    const Runtime = {
      evaluate: vi.fn(({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) {
          return Promise.resolve({
            result: { value: { href: "https://chatgpt.com/", readyState: "complete" } },
          });
        }
        if (expression.includes("Boolean(window.__oracleChatGptInventory?.ready)")) {
          return Promise.resolve({ result: { value: true } });
        }
        if (
          expression.includes("inventory.readCookieIdentity(") ||
          expression.includes("inventory.bindRetainedAuthorization(")
        ) {
          return Promise.resolve({
            result: {
              value: {
                ok: true,
                status: 200,
                url: "https://chatgpt.com/api/auth/session",
                redirected: false,
                accountDigest,
                email: "owner@example.test",
              },
            },
          });
        }
        if (expression.includes("inventory.fetchPage")) {
          const archived = expression.includes('is_archived\', "true"');
          if (!archived) {
            activeAttempts += 1;
            if (activeAttempts <= 4) {
              if (activeAttempts === 1) signalFirstPage();
              return Promise.resolve({
                result: {
                  value: {
                    ok: false,
                    status: 429,
                    reason: "http",
                    url: activeUrl,
                    redirected: false,
                  },
                },
              });
            }
          }
          return Promise.resolve({
            result: {
              value: {
                ok: true,
                status: 200,
                url: archived ? archivedUrl : activeUrl,
                redirected: false,
                body: { items: [], total: 0, limit: 100, offset: 0 },
              },
            },
          });
        }
        if (expression.includes("const inventory = window.__oracleChatGptInventory;")) {
          return Promise.resolve({ result: { value: true } });
        }
        return Promise.resolve({ result: { value: undefined } });
      }),
    } as unknown as ChromeClient["Runtime"];
    const Page = {
      enable: vi.fn(async () => undefined),
      addScriptToEvaluateOnNewDocument: vi.fn(async () => ({ identifier: "inventory-hook" })),
      removeScriptToEvaluateOnNewDocument: vi.fn(async () => undefined),
      navigate: vi.fn(async () => ({ frameId: "inventory-frame" })),
    };
    chromeMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: { Page, Runtime },
      targetId: "inventory-target",
      browserWSEndpoint,
      close: vi.fn(async () => undefined),
    });

    const capture = captureChatGptConversationInventory({
      host: "127.0.0.1",
      port: 9223,
      browserId: "browser-a",
      browserWSEndpoint,
      expectedEmail: "owner@example.test",
    });

    await firstPage;
    await vi.runAllTimersAsync();

    await expect(capture).resolves.toEqual({ accountDigest, items: [] });
    expect(activeAttempts).toBe(5);
    expect(Date.now()).toBe(420_000);
  });
  test("uses one inventory deadline through a retry and stalled page request", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    const activeUrl =
      "https://chatgpt.com/backend-api/conversations?offset=0&limit=100&order=updated&is_archived=false";
    const events: string[] = [];
    let documentChecks = 0;
    let pageCalls = 0;
    let stalledPageExpression = "";
    let signalStalledPageStarted!: () => void;
    const stalledPageStarted = new Promise<void>((resolve) => {
      signalStalledPageStarted = resolve;
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    const Runtime = {
      evaluate: vi.fn(({ expression }: { expression: string }) => {
        if (expression.includes("inventory.cleanup")) {
          events.push("cleanup");
          return Promise.resolve({ result: { value: true } });
        }
        if (expression.includes("readyState: document.readyState")) {
          documentChecks += 1;
          return Promise.resolve({
            result: {
              value: {
                href: "https://chatgpt.com/",
                readyState: documentChecks === 1 ? "loading" : "complete",
              },
            },
          });
        }
        if (expression.includes("Boolean(window.__oracleChatGptInventory?.ready)")) {
          return Promise.resolve({ result: { value: true } });
        }
        if (
          expression.includes("inventory.readCookieIdentity(") ||
          expression.includes("inventory.bindRetainedAuthorization(")
        ) {
          return Promise.resolve({
            result: {
              value: {
                ok: true,
                status: 200,
                url: "https://chatgpt.com/api/auth/session",
                redirected: false,
                accountDigest,
                email: "owner@example.test",
              },
            },
          });
        }
        if (expression.includes("inventory.fetchPage")) {
          pageCalls += 1;
          if (pageCalls === 1) {
            return Promise.resolve({
              result: {
                value: {
                  ok: false,
                  status: 429,
                  reason: "http",
                  retryAfterMs: 100,
                  url: activeUrl,
                  redirected: false,
                },
              },
            });
          }
          stalledPageExpression = expression;
          signalStalledPageStarted();
          return new Promise<never>(() => undefined);
        }
        return Promise.resolve({ result: { value: undefined } });
      }),
    } as unknown as ChromeClient["Runtime"];
    const Page = {
      enable: vi.fn(async () => undefined),
      addScriptToEvaluateOnNewDocument: vi.fn(async () => ({ identifier: "inventory-hook" })),
      removeScriptToEvaluateOnNewDocument: vi.fn(async () => {
        events.push("remove-script");
      }),
      navigate: vi.fn(async () => ({ frameId: "inventory-frame" })),
    };
    const close = vi.fn(async () => {
      events.push("detach");
    });
    chromeMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: { Page, Runtime },
      targetId: "inventory-target",
      browserWSEndpoint,
      close,
    });

    const capture = captureChatGptConversationInventory({
      host: "127.0.0.1",
      port: 9223,
      browserId: "browser-a",
      browserWSEndpoint,
      expectedEmail: "owner@example.test",
      timeoutMs: 250,
    });
    const captureFailure = capture.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await stalledPageStarted;
    expect(stalledPageExpression).toContain("const budgetMs = 50;");
    expect(stalledPageExpression).toContain("const deadline = Date.now() + budgetMs;");
    expect(buildChatGptInventoryAuthCaptureHook()).toContain("controller = new AbortController()");
    expect(buildChatGptInventoryAuthCaptureHook()).toContain("signal: controller.signal");

    await vi.advanceTimersByTimeAsync(50);
    const failure = await captureFailure;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /timed out while ChatGPT conversation inventory request/i,
    );
    expect(documentChecks).toBe(2);
    expect(pageCalls).toBe(2);
    expect(events).toEqual(["cleanup", "remove-script", "detach"]);
    expect(chromeMocks.closeTab).toHaveBeenCalledWith(
      9223,
      "inventory-target",
      expect.any(Function),
      "127.0.0.1",
    );
  });

  test("bounds stalled cleanup steps and still attempts later disposable-target cleanup", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const cleanupEvents: string[] = [];
    let signalNavigationStarted!: () => void;
    const navigationStarted = new Promise<void>((resolve) => {
      signalNavigationStarted = resolve;
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    const Runtime = {
      evaluate: vi.fn(({ expression }: { expression: string }) => {
        if (expression.includes("const inventory = window.__oracleChatGptInventory;")) {
          cleanupEvents.push("authorization-cleanup");
          return new Promise<never>(() => undefined);
        }
        return Promise.resolve({ result: { value: undefined } });
      }),
    } as unknown as ChromeClient["Runtime"];
    const Page = {
      enable: vi.fn(async () => undefined),
      addScriptToEvaluateOnNewDocument: vi.fn(async () => ({ identifier: "inventory-hook" })),
      removeScriptToEvaluateOnNewDocument: vi.fn(() => {
        cleanupEvents.push("remove-script");
        return new Promise<never>(() => undefined);
      }),
      navigate: vi.fn(() => {
        signalNavigationStarted();
        return new Promise<never>(() => undefined);
      }),
    };
    const close = vi.fn(() => {
      cleanupEvents.push("detach");
      return new Promise<never>(() => undefined);
    });
    chromeMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: { Page, Runtime },
      targetId: "inventory-target",
      browserWSEndpoint,
      close,
    });
    chromeMocks.closeTab.mockImplementation(() => {
      cleanupEvents.push("close-target");
      return new Promise<never>(() => undefined);
    });

    const capture = captureChatGptConversationInventory({
      host: "127.0.0.1",
      port: 9223,
      browserId: "browser-a",
      browserWSEndpoint,
      expectedEmail: "owner@example.test",
      timeoutMs: 100,
    });
    const failure = capture.catch((error: unknown) => error);

    await navigationStarted;
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    await expect(failure).resolves.toBeInstanceOf(AggregateError);
    expect(cleanupEvents).toEqual([
      "authorization-cleanup",
      "remove-script",
      "detach",
      "close-target",
    ]);
    expect(Page.removeScriptToEvaluateOnNewDocument).toHaveBeenCalledWith({
      identifier: "inventory-hook",
    });
    expect(close).toHaveBeenCalledOnce();
    expect(chromeMocks.closeTab).toHaveBeenCalledOnce();
  });

  test.each([
    [
      "mismatched bearer identity",
      {
        ok: true,
        status: 200,
        url: "https://chatgpt.com/api/auth/session",
        redirected: false,
        accountDigest: "b".repeat(64),
        email: "owner@example.test",
      },
      /retained ChatGPT authorization does not match/i,
    ],
    [
      "missing bearer identity",
      {
        ok: true,
        status: 200,
        url: "https://chatgpt.com/api/auth/session",
        redirected: false,
        email: "owner@example.test",
      },
      /bearer identity is unavailable/i,
    ],
    [
      "redirected bearer identity",
      {
        ok: true,
        status: 200,
        url: "https://chatgpt.com/api/auth/session",
        redirected: true,
        accountDigest: "a".repeat(64),
        email: "owner@example.test",
      },
      /redirected/i,
    ],
  ])("fails closed on %s before pagination", async (_case, bearerIdentity, expectedError) => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    let inventoryRequestStarted = false;
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) {
          return {
            result: { value: { href: "https://chatgpt.com/", readyState: "complete" } },
          };
        }
        if (expression.includes("Boolean(window.__oracleChatGptInventory?.ready)")) {
          return { result: { value: true } };
        }
        if (expression.includes("inventory.readCookieIdentity(")) {
          return {
            result: {
              value: {
                ok: true,
                status: 200,
                url: "https://chatgpt.com/api/auth/session",
                redirected: false,
                accountDigest,
                email: "owner@example.test",
              },
            },
          };
        }
        if (expression.includes("inventory.bindRetainedAuthorization(")) {
          return { result: { value: bearerIdentity } };
        }
        if (expression.includes("inventory.fetchPage")) inventoryRequestStarted = true;
        if (expression.includes("inventory.cleanup")) {
          return { result: { value: true } };
        }
        return { result: { value: undefined } };
      }),
    } as unknown as ChromeClient["Runtime"];
    chromeMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: {
        Runtime,
        Page: {
          enable: vi.fn(async () => undefined),
          addScriptToEvaluateOnNewDocument: vi.fn(async () => ({ identifier: "inventory-hook" })),
          removeScriptToEvaluateOnNewDocument: vi.fn(async () => undefined),
          navigate: vi.fn(async () => ({ frameId: "inventory-frame" })),
        },
      },
      targetId: "inventory-target",
      browserWSEndpoint,
      close: vi.fn(async () => undefined),
    });

    await expect(
      captureChatGptConversationInventory({
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        browserWSEndpoint,
        expectedEmail: "owner@example.test",
      }),
    ).rejects.toThrow(expectedError);
    expect(inventoryRequestStarted).toBe(false);
  });

  test("rejects a list response whose exact URL does not match the request", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    let inventoryCalls = 0;
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) {
          return {
            result: { value: { href: "https://chatgpt.com/", readyState: "complete" } },
          };
        }
        if (expression.includes("Boolean(window.__oracleChatGptInventory?.ready)")) {
          return { result: { value: true } };
        }
        if (
          expression.includes("inventory.readCookieIdentity(") ||
          expression.includes("inventory.bindRetainedAuthorization(")
        ) {
          return {
            result: {
              value: {
                ok: true,
                status: 200,
                url: "https://chatgpt.com/api/auth/session",
                redirected: false,
                accountDigest,
                email: "owner@example.test",
              },
            },
          };
        }
        if (expression.includes("inventory.fetchPage")) {
          inventoryCalls += 1;
          return {
            result: {
              value: {
                ok: true,
                status: 200,
                url: "https://chatgpt.com/backend-api/conversations?offset=1&limit=100&order=updated&is_archived=false",
                redirected: false,
                body: { items: [], total: 0, limit: 100, offset: 0 },
              },
            },
          };
        }
        if (expression.includes("inventory.cleanup")) {
          return { result: { value: true } };
        }
        return { result: { value: undefined } };
      }),
    } as unknown as ChromeClient["Runtime"];
    chromeMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: {
        Runtime,
        Page: {
          enable: vi.fn(async () => undefined),
          addScriptToEvaluateOnNewDocument: vi.fn(async () => ({ identifier: "inventory-hook" })),
          removeScriptToEvaluateOnNewDocument: vi.fn(async () => undefined),
          navigate: vi.fn(async () => ({ frameId: "inventory-frame" })),
        },
      },
      targetId: "inventory-target",
      browserWSEndpoint,
      close: vi.fn(async () => undefined),
    });

    await expect(
      captureChatGptConversationInventory({
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        browserWSEndpoint,
        expectedEmail: "owner@example.test",
      }),
    ).rejects.toThrow(/response URL did not match its exact request/i);
    expect(inventoryCalls).toBe(1);
  });
});
