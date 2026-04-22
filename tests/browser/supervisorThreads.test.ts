import vm from "node:vm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  __test__,
  attachSupervisorThread,
  listSupervisorThreads,
  newSupervisorThread,
  readCurrentSupervisorThread,
  readAttachedSupervisorThreadHistory,
  readSupervisorThreadHistory,
} from "../../src/browser/supervisorThreads.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { openConversationFromSidebarWithRetry } from "../../src/browser/reattachHelpers.js";
import { readAssistantSnapshot } from "../../src/browser/pageActions.js";

vi.mock("../../src/browser/utils.js", () => ({
  delay: vi.fn(async () => undefined),
}));

vi.mock("../../src/browser/reattachHelpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/browser/reattachHelpers.js")>();
  return {
    ...actual,
    openConversationFromSidebarWithRetry: vi.fn(),
  };
});

vi.mock("../../src/browser/pageActions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/browser/pageActions.js")>();
  return {
    ...actual,
    readAssistantSnapshot: vi.fn(),
  };
});

const isThreadSelector = (selector: string) =>
  selector.includes('[data-testid^="conversation-turn"]') ||
  selector.includes("[data-message-author-role]") ||
  selector.includes("[data-turn]");

const isExcludedSelector = (selector: string) =>
  selector.includes(
    'nav,aside,form,[data-testid*="sidebar"],[data-testid*="chat-history"],[data-testid*="composer"],section[data-testid="screen-threadFlyOut"],[data-testid*="threadFlyOut"]',
  );

function evaluateVisibleTurnCountForBadShape(expression: string): number {
  const expectedLink = {
    getAttribute: (name: string) => (name === "href" ? "/c/target-9" : null),
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    matches: () => false,
    contains: (node: unknown) => node === expectedLink,
    cloneNode: () => expectedLink,
    innerText: "",
    textContent: "",
  };
  const turn = {
    getAttribute: (name: string) => {
      if (name === "data-testid") return "conversation-turn-1";
      if (name === "data-message-author-role") return "assistant";
      return null;
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: (selector: string) => {
      if (isExcludedSelector(selector)) return null;
      return isThreadSelector(selector) ? turn : null;
    },
    matches: (selector: string) => isThreadSelector(selector),
    contains: (node: unknown) => node === turn,
    cloneNode: () => ({
      querySelectorAll: () => [],
      querySelector: () => null,
      innerText: "Wrong pane answer",
      textContent: "Wrong pane answer",
      remove: () => undefined,
    }),
    innerText: "Wrong pane answer",
    textContent: "Wrong pane answer",
  };
  const main = {
    getAttribute: (name: string) => {
      if (name === "data-conversation-id") return "wrong-4";
      if (name === "role") return "main";
      return null;
    },
    querySelectorAll: (selector: string) => {
      if (selector.includes('href*="/c/"')) return [expectedLink];
      if (isThreadSelector(selector)) return [turn];
      return [];
    },
    querySelector: () => null,
    closest: () => null,
    matches: (selector: string) =>
      selector
        .split(",")
        .map((value) => value.trim())
        .some((value) => value === "main" || value === '[role="main"]'),
    contains: (node: unknown) => node === main || node === turn || node === expectedLink,
    cloneNode: () => main,
    innerText: "",
    textContent: "",
  };
  const body = {
    getAttribute: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    matches: () => false,
    contains: (node: unknown) => node === body,
    cloneNode: () => body,
    innerText: "",
    textContent: "",
  };
  const document = {
    body,
    querySelector: (selector: string) => {
      if (selector === "main" || selector === '[role="main"]') return main;
      return null;
    },
  };
  const value = vm.runInNewContext(expression, {
    document,
    window: { location: { href: "https://chatgpt.com/c/target-9" } },
    URL,
  });
  return Number(value) || 0;
}

describe("supervisorThreads", () => {
  const projectUrl = "https://chatgpt.com/g/team-space/project";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readAssistantSnapshot).mockResolvedValue(null);
  });

  test("normalizes raw thread metadata", () => {
    const normalized = __test__.normalizeSupervisorThread({
      title: "  Thread A  ",
      url: "https://chatgpt.com/c/abc-123",
      conversationId: "",
      isActive: true,
    });
    expect(normalized).toEqual({
      title: "Thread A",
      url: "https://chatgpt.com/c/abc-123",
      conversationId: "abc-123",
      isActive: true,
    });
  });

  test("reads current thread from runtime", async () => {
    const runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: {
            url: "https://chatgpt.com/c/current-9",
            conversationId: "current-9",
            title: "Current Chat",
            isActive: true,
          },
        },
      })),
    } as unknown as ChromeClient["Runtime"];

    const thread = await readCurrentSupervisorThread(runtime);
    expect(thread).toEqual({
      title: "Current Chat",
      url: "https://chatgpt.com/c/current-9",
      conversationId: "current-9",
      isActive: true,
    });
  });

  test("lists and limits threads from runtime", async () => {
    const runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: [
            { title: "One", url: "https://chatgpt.com/c/one", conversationId: "one" },
            { title: "Fresh", url: "https://chatgpt.com/", conversationId: "" },
            { title: "Two", url: "https://chatgpt.com/c/two", conversationId: "two" },
            { title: "Three", url: "https://chatgpt.com/c/three", conversationId: "three" },
          ],
        },
      })),
    } as unknown as ChromeClient["Runtime"];

    const threads = await listSupervisorThreads(runtime, { limit: 2 });
    expect(threads).toEqual([
      { title: "One", url: "https://chatgpt.com/c/one", conversationId: "one", isActive: false },
      { title: "Two", url: "https://chatgpt.com/c/two", conversationId: "two", isActive: false },
    ]);
  });

  test("filters listed threads to the configured project scope", async () => {
    const runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: [
            {
              title: "In scope",
              url: "https://chatgpt.com/g/team-space-oracle/c/right-thread",
              conversationId: "right-thread",
            },
            {
              title: "Root chat",
              url: "https://chatgpt.com/c/root-thread",
              conversationId: "root-thread",
            },
            {
              title: "Other project",
              url: "https://chatgpt.com/g/other-space-oracle/c/other-thread",
              conversationId: "other-thread",
            },
          ],
        },
      })),
    } as unknown as ChromeClient["Runtime"];

    const threads = await listSupervisorThreads(runtime, {
      projectUrl,
    });

    expect(threads).toEqual([
      {
        title: "In scope",
        url: "https://chatgpt.com/g/team-space-oracle/c/right-thread",
        conversationId: "right-thread",
        isActive: false,
      },
    ]);
  });

  test("attach_thread waits until the requested conversation is active", async () => {
    vi.mocked(openConversationFromSidebarWithRetry).mockResolvedValue(true);
    let currentReads = 0;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
        return { result: { value: 2 } };
      }
      if (expression.includes("const href = window.location.href || ''")) {
        currentReads += 1;
        if (currentReads < 3) {
          return {
            result: {
              value: {
                url: "https://chatgpt.com/g/team-space/c/current-1",
                conversationId: "current-1",
                title: "Current",
                isActive: true,
              },
            },
          };
        }
        return {
          result: {
            value: {
              url: "https://chatgpt.com/g/team-space/c/target-9",
              conversationId: "target-9",
              title: "Target",
              isActive: true,
            },
          },
        };
      }
      if (expression.includes("const limit =")) {
        return {
          result: {
            value: [
              {
                title: "Current",
                url: "https://chatgpt.com/g/team-space/c/current-1",
                conversationId: "current-1",
                isActive: true,
              },
            ],
          },
        };
      }
      return { result: { value: null } };
    });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const thread = await attachSupervisorThread(runtime, "target-9", {
      projectUrl,
    });

    expect(openConversationFromSidebarWithRetry).not.toHaveBeenCalled();
    expect(thread).toEqual({
      title: "Target",
      url: "https://chatgpt.com/g/team-space/c/target-9",
      conversationId: "target-9",
      isActive: true,
    });
  });

  test("attach_thread reconstructs a project-scoped thread URL before relying on sidebar lookup", async () => {
    let currentReads = 0;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 2 } };
        }
        if (expression.includes("window.location.assign")) {
          return { result: { value: true } };
        }
        if (expression.includes("const href = window.location.href || ''")) {
          currentReads += 1;
          return {
            result: {
              value:
                currentReads < 2
                  ? {
                      url: "https://chatgpt.com/g/team-space-oracle/c/current-1",
                      conversationId: "current-1",
                      title: "Current",
                      isActive: true,
                    }
                  : {
                      url: "https://chatgpt.com/g/team-space/c/target-9",
                      conversationId: "target-9",
                      title: "Target",
                      isActive: true,
                    },
            },
          };
        }
        throw new Error(`Unexpected expression: ${expression}`);
      }),
    } as unknown as ChromeClient["Runtime"];

    const thread = await attachSupervisorThread(runtime, "target-9", {
      projectUrl,
    });

    expect(thread).toEqual({
      title: "Target",
      url: "https://chatgpt.com/g/team-space/c/target-9",
      conversationId: "target-9",
      isActive: true,
    });
    expect(openConversationFromSidebarWithRetry).not.toHaveBeenCalled();
  });

  test("attach_thread waits for the visible thread to switch instead of trusting sidebar state", async () => {
    vi.mocked(openConversationFromSidebarWithRetry).mockResolvedValue(true);
    let currentReadCount = 0;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 2 } };
        }
        if (expression.includes("const href = window.location.href || ''")) {
          currentReadCount += 1;
          if (currentReadCount < 3) {
            return {
              result: {
                value: {
                  url: "https://chatgpt.com/g/team-space/c/current-1",
                  conversationId: "current-1",
                  title: "Current",
                  isActive: true,
                },
              },
            };
          }
          return {
            result: {
              value: {
                url: "https://chatgpt.com/g/team-space/c/target-9",
                conversationId: "target-9",
                title: "Target",
                isActive: true,
              },
            },
          };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    const thread = await attachSupervisorThread(runtime, "target-9", {
      projectUrl,
    });

    expect(thread).toEqual({
      title: "Target",
      url: "https://chatgpt.com/g/team-space/c/target-9",
      conversationId: "target-9",
      isActive: true,
    });
    expect(currentReadCount).toBeGreaterThanOrEqual(3);
  });

  test("attach_thread accepts root/main attach when a readable assistant snapshot is present", async () => {
    let currentReadCount = 0;
    vi.mocked(readAssistantSnapshot).mockResolvedValue({
      text: "Prior assistant reply.",
      html: "<p>Prior assistant reply.</p>",
    });
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 0 } };
        }
        if (expression.includes("window.location.assign")) {
          return { result: { value: true } };
        }
        if (expression.includes("const href = window.location.href || ''")) {
          currentReadCount += 1;
          return {
            result: {
              value:
                currentReadCount < 2
                  ? {
                      url: "https://chatgpt.com/c/current-1",
                      conversationId: "current-1",
                      title: "Current",
                      isActive: true,
                    }
                  : {
                      url: "https://chatgpt.com/c/target-9",
                      conversationId: "target-9",
                      title: "Root seed thread",
                      isActive: true,
                    },
            },
          };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    const thread = await attachSupervisorThread(runtime, "target-9", {
      threadUrl: "https://chatgpt.com/c/target-9",
    });

    expect(thread).toEqual({
      title: "Root seed thread",
      url: "https://chatgpt.com/c/target-9",
      conversationId: "target-9",
      isActive: true,
    });
    expect(readAssistantSnapshot).toHaveBeenCalled();
  });

  test("attach_thread fails closed when visible turns come from a wrong root that only has a descendant expected link", async () => {
    vi.mocked(openConversationFromSidebarWithRetry).mockResolvedValue(true);
    let now = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 3_000;
      return now;
    });
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: evaluateVisibleTurnCountForBadShape(expression) } };
        }
        if (expression.includes("const href = window.location.href || ''")) {
          return {
            result: {
              value: {
                url: "https://chatgpt.com/c/target-9",
                conversationId: "target-9",
                title: "Target",
                isActive: true,
              },
            },
          };
        }
        throw new Error(`Unexpected expression: ${expression}`);
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(attachSupervisorThread(runtime, "target-9")).rejects.toThrow(
      "Conversation target-9 did not become active after attach_thread",
    );
    expect(openConversationFromSidebarWithRetry).toHaveBeenCalledWith(
      runtime,
      { conversationId: "target-9", preferProjects: true },
      15_000,
    );
    dateNow.mockRestore();
  });

  test("attach_thread keeps fail-closed for root/main blank shells despite snapshot fallback", async () => {
    let now = 0;
    vi.mocked(readAssistantSnapshot).mockResolvedValue({
      text: "Thinking",
      html: '<div class="result-thinking"></div>',
    });
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 3_000;
      return now;
    });
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 0 } };
        }
        if (expression.includes("window.location.assign")) {
          return { result: { value: true } };
        }
        if (expression.includes("const href = window.location.href || ''")) {
          return {
            result: {
              value: {
                url: "https://chatgpt.com/c/target-9",
                conversationId: "target-9",
                title: "ChatGPT",
                isActive: true,
              },
            },
          };
        }
        throw new Error(`Unexpected expression: ${expression}`);
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      attachSupervisorThread(runtime, "target-9", {
        threadUrl: "https://chatgpt.com/c/target-9",
      }),
    ).rejects.toThrow("Conversation target-9 did not become active after attach_thread");
    dateNow.mockRestore();
  });

  test("attach_thread fails closed when direct URL navigation lands on a blank shell for the requested conversation", async () => {
    let now = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 3_000;
      return now;
    });
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 0 } };
        }
        if (expression.includes("window.location.assign")) {
          return { result: { value: true } };
        }
        if (expression.includes("const href = window.location.href || ''")) {
          return {
            result: {
              value: {
                url: "https://chatgpt.com/g/team-space-oracle/c/target-9",
                conversationId: "target-9",
                title: "ChatGPT",
                isActive: true,
              },
            },
          };
        }
        throw new Error(`Unexpected expression: ${expression}`);
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      attachSupervisorThread(runtime, "target-9", {
        projectUrl,
        threadUrl: "https://chatgpt.com/g/team-space-oracle/c/target-9",
      }),
    ).rejects.toThrow("Conversation target-9 did not become active after attach_thread");
    dateNow.mockRestore();
  });

  test("attach_thread fails closed when only a secondary pane has visible turns", async () => {
    let now = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 3_000;
      return now;
    });
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 0 } };
        }
        if (expression.includes("window.location.assign")) {
          return { result: { value: true } };
        }
        if (expression.includes("const href = window.location.href || ''")) {
          return {
            result: {
              value: {
                url: "https://chatgpt.com/g/team-space-oracle/c/target-9",
                conversationId: "target-9",
                title: "Target",
                isActive: true,
              },
            },
          };
        }
        throw new Error(`Unexpected expression: ${expression}`);
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      attachSupervisorThread(runtime, "target-9", {
        projectUrl,
        threadUrl: "https://chatgpt.com/g/team-space-oracle/c/target-9",
      }),
    ).rejects.toThrow("Conversation target-9 did not become active after attach_thread");
    dateNow.mockRestore();
  });

  test("attach_thread accepts direct URL navigation only after visible conversation turns load", async () => {
    let currentReadCount = 0;
    let turnCountReads = 0;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          turnCountReads += 1;
          return {
            result: {
              value: turnCountReads < 2 ? 0 : 2,
            },
          };
        }
        if (expression.includes("window.location.assign")) {
          return { result: { value: true } };
        }
        if (expression.includes("const href = window.location.href || ''")) {
          currentReadCount += 1;
          return {
            result: {
              value:
                currentReadCount < 2
                  ? {
                      url: "https://chatgpt.com/g/team-space/c/current-1",
                      conversationId: "current-1",
                      title: "Current",
                      isActive: true,
                    }
                  : {
                      url: "https://chatgpt.com/g/team-space-oracle/c/target-9",
                      conversationId: "target-9",
                      title: "Target",
                      isActive: true,
                    },
            },
          };
        }
        throw new Error(`Unexpected expression: ${expression}`);
      }),
    } as unknown as ChromeClient["Runtime"];

    const thread = await attachSupervisorThread(runtime, "target-9", {
      projectUrl,
      threadUrl: "https://chatgpt.com/g/team-space-oracle/c/target-9",
    });

    expect(thread).toEqual({
      title: "Target",
      url: "https://chatgpt.com/g/team-space-oracle/c/target-9",
      conversationId: "target-9",
      isActive: true,
    });
    expect(turnCountReads).toBeGreaterThanOrEqual(2);
  });

  test("attach_thread repairs direct URL attach when another in-scope thread stays active", async () => {
    let now = 0;
    let navigationCount = 0;
    let sidebarRepairCount = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 500;
      return now;
    });
    vi.mocked(openConversationFromSidebarWithRetry).mockImplementation(async () => {
      sidebarRepairCount += 1;
      return true;
    });
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 2 } };
        }
        if (expression.includes("window.location.assign")) {
          navigationCount += 1;
          return { result: { value: true } };
        }
        if (expression.includes("const href = window.location.href || ''")) {
          if (sidebarRepairCount > 0) {
            return {
              result: {
                value: {
                  url: "https://chatgpt.com/g/team-space-oracle/c/target-9",
                  conversationId: "target-9",
                  title: "Target",
                  isActive: true,
                },
              },
            };
          }
          return {
            result: {
              value: {
                url: "https://chatgpt.com/g/team-space-oracle/c/other-3",
                conversationId: "other-3",
                title: "Other",
                isActive: true,
              },
            },
          };
        }
        throw new Error(`Unexpected expression: ${expression}`);
      }),
    } as unknown as ChromeClient["Runtime"];

    const thread = await attachSupervisorThread(runtime, "target-9", {
      projectUrl,
      threadUrl: "https://chatgpt.com/g/team-space-oracle/c/target-9",
    });

    expect(thread).toEqual({
      title: "Target",
      url: "https://chatgpt.com/g/team-space-oracle/c/target-9",
      conversationId: "target-9",
      isActive: true,
    });
    expect(navigationCount).toBeGreaterThanOrEqual(2);
    expect(openConversationFromSidebarWithRetry).toHaveBeenCalledWith(
      runtime,
      { conversationId: "target-9", preferProjects: true },
      15_000,
    );
    dateNow.mockRestore();
  });

  test("readSupervisorThreadHistory returns normalized transcript entries", async () => {
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("const turnSelector =")) {
          return {
            result: {
              value: [
                { role: "ignored", text: "skip me" },
                { role: "user", text: "Follow-up" },
                { role: "assistant", text: "Final answer" },
                { role: "assistant", text: "Wrap-up" },
              ],
            },
          };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    const result = await readSupervisorThreadHistory(runtime, { limit: 3 });

    expect(result).toEqual([
      { role: "user", text: "Follow-up" },
      { role: "assistant", text: "Final answer" },
      { role: "assistant", text: "Wrap-up" },
    ]);
  });

  test("readSupervisorThreadHistorySnapshot keeps polling until the active conversation container validates", async () => {
    let snapshotReads = 0;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (!expression.includes("const turnSelector =")) {
          throw new Error(`Unexpected expression: ${expression}`);
        }
        snapshotReads += 1;
        if (snapshotReads < 4) {
          return {
            result: {
              value: {
                thread: {
                  url: "https://chatgpt.com/g/team-space-oracle/c/current-9",
                  conversationId: "current-9",
                  title: "Current Chat",
                  isActive: true,
                },
                history: [],
                historyWindow: {
                  limit: 1,
                  returnedCount: 0,
                  totalCount: 0,
                  truncated: false,
                },
                activeRootValidated: false,
              },
            },
          };
        }
        return {
          result: {
            value: {
              thread: {
                url: "https://chatgpt.com/g/team-space-oracle/c/current-9",
                conversationId: "current-9",
                title: "Current Chat",
                isActive: true,
              },
              history: [{ role: "assistant", text: "Recent answer" }],
              historyWindow: {
                limit: 1,
                returnedCount: 1,
                totalCount: 1,
                truncated: false,
              },
              activeRootValidated: true,
            },
          },
        };
      }),
    } as unknown as ChromeClient["Runtime"];

    const snapshot = await __test__.readSupervisorThreadHistorySnapshot(runtime, { limit: 1 });

    expect(snapshot.activeRootValidated).toBe(true);
    expect(snapshot.placeholderShellUnderfill).toBe(false);
    expect(snapshot.history).toEqual([{ role: "assistant", text: "Recent answer" }]);
    expect(snapshotReads).toBeGreaterThanOrEqual(4);
  });

  test("readSupervisorThreadHistorySnapshot exposes placeholder shell underfill signal", async () => {
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (!expression.includes("const turnSelector =")) {
          throw new Error(`Unexpected expression: ${expression}`);
        }
        return {
          result: {
            value: {
              thread: {
                url: "https://chatgpt.com/g/team-space-oracle/c/current-9",
                conversationId: "current-9",
                title: "Current Chat",
                isActive: true,
              },
              history: [{ role: "assistant", text: "Recent answer" }],
              historyWindow: {
                limit: 3,
                returnedCount: 1,
                totalCount: 1,
                truncated: false,
              },
              activeRootValidated: true,
              placeholderShellUnderfill: true,
            },
          },
        };
      }),
    } as unknown as ChromeClient["Runtime"];

    const snapshot = await __test__.readSupervisorThreadHistorySnapshot(runtime, { limit: 3 });

    expect(snapshot.activeRootValidated).toBe(true);
    expect(snapshot.placeholderShellUnderfill).toBe(true);
    expect(snapshot.history).toEqual([{ role: "assistant", text: "Recent answer" }]);
  });

  test("readAttachedSupervisorThreadHistory surfaces bounded window metadata", async () => {
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 2 } };
        }
        if (expression.includes("window.location.href") && expression.includes("historyWindow")) {
          return {
            result: {
              value: {
                thread: {
                  url: "https://chatgpt.com/c/current-9",
                  conversationId: "current-9",
                  title: "Current Chat",
                  isActive: true,
                },
                history: [
                  { role: "assistant", text: "Recent answer" },
                  { role: "user", text: "Latest question" },
                ],
                historyWindow: {
                  limit: 2,
                  returnedCount: 2,
                  totalCount: 5,
                  truncated: true,
                },
              },
            },
          };
        }
        if (expression.includes("window.location.href")) {
          return {
            result: {
              value: {
                url: "https://chatgpt.com/c/current-9",
                conversationId: "current-9",
                title: "Current Chat",
                isActive: true,
              },
            },
          };
        }
        throw new Error(`Unexpected expression: ${expression}`);
      }),
    } as unknown as ChromeClient["Runtime"];

    const result = await readAttachedSupervisorThreadHistory(runtime, {
      conversationId: "current-9",
      limit: 2,
    });

    expect(result.history).toEqual([
      { role: "assistant", text: "Recent answer" },
      { role: "user", text: "Latest question" },
    ]);
    expect(result.historyWindow).toEqual({
      limit: 2,
      returnedCount: 2,
      totalCount: 5,
      truncated: true,
    });
  });

  test("readAttachedSupervisorThreadHistory retries once through the sidebar when the first snapshot cannot validate the active root", async () => {
    let sidebarRepairCount = 0;
    vi.mocked(openConversationFromSidebarWithRetry).mockImplementation(async () => {
      sidebarRepairCount += 1;
      return true;
    });
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 0 } };
        }
        if (expression.includes("const turnSelector =")) {
          if (sidebarRepairCount === 0) {
            return {
              result: {
                value: {
                  thread: {
                    url: "https://chatgpt.com/g/team-space-oracle/c/current-9",
                    conversationId: "current-9",
                    title: "Current Chat",
                    isActive: true,
                  },
                  history: [],
                  historyWindow: {
                    limit: 1,
                    returnedCount: 0,
                    totalCount: 0,
                    truncated: false,
                  },
                  activeRootValidated: false,
                },
              },
            };
          }
          return {
            result: {
              value: {
                thread: {
                  url: "https://chatgpt.com/g/team-space-oracle/c/current-9",
                  conversationId: "current-9",
                  title: "Current Chat",
                  isActive: true,
                },
                history: [{ role: "assistant", text: "Recovered answer" }],
                historyWindow: {
                  limit: 1,
                  returnedCount: 1,
                  totalCount: 1,
                  truncated: false,
                },
                activeRootValidated: true,
              },
            },
          };
        }
        if (expression.includes("const href = window.location.href || ''")) {
          return {
            result: {
              value: {
                url: "https://chatgpt.com/g/team-space-oracle/c/current-9",
                conversationId: "current-9",
                title: "Current Chat",
                isActive: true,
              },
            },
          };
        }
        throw new Error(`Unexpected expression: ${expression}`);
      }),
    } as unknown as ChromeClient["Runtime"];

    const result = await readAttachedSupervisorThreadHistory(runtime, {
      conversationId: "current-9",
      projectUrl,
      limit: 1,
    });

    expect(result.history).toEqual([{ role: "assistant", text: "Recovered answer" }]);
    expect(openConversationFromSidebarWithRetry).toHaveBeenCalledWith(
      runtime,
      { conversationId: "current-9", preferProjects: true },
      5_000,
    );
  });

  test("readAttachedSupervisorThreadHistory reattaches with the provided project thread URL when sidebar lookup would miss", async () => {
    let currentReadCount = 0;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 0 } };
        }
        if (expression.includes("window.location.assign")) {
          return { result: { value: true } };
        }
        if (expression.includes("window.location.href") && expression.includes("historyWindow")) {
          return {
            result: {
              value: {
                thread: {
                  url: "https://chatgpt.com/g/team-space-oracle/c/target-9",
                  conversationId: "target-9",
                  title: "Target",
                  isActive: true,
                },
                history: [
                  { role: "user", text: "Follow-up" },
                  { role: "assistant", text: "Recent answer" },
                ],
                historyWindow: {
                  limit: 2,
                  returnedCount: 2,
                  totalCount: 2,
                  truncated: false,
                },
              },
            },
          };
        }
        if (expression.includes("const href = window.location.href || ''")) {
          currentReadCount += 1;
          return {
            result: {
              value:
                currentReadCount < 2
                  ? {
                      url: "https://chatgpt.com/g/team-space-oracle/c/current-1",
                      conversationId: "current-1",
                      title: "Current",
                      isActive: true,
                    }
                  : {
                      url: "https://chatgpt.com/g/team-space-oracle/c/target-9",
                      conversationId: "target-9",
                      title: "Target",
                      isActive: true,
                    },
            },
          };
        }
        throw new Error(`Unexpected expression: ${expression}`);
      }),
    } as unknown as ChromeClient["Runtime"];

    const result = await readAttachedSupervisorThreadHistory(runtime, {
      conversationId: "target-9",
      projectUrl,
      threadUrl: "https://chatgpt.com/g/team-space-oracle/c/target-9",
      limit: 2,
    });

    expect(result.thread).toEqual({
      title: "Target",
      url: "https://chatgpt.com/g/team-space-oracle/c/target-9",
      conversationId: "target-9",
      isActive: true,
    });
    expect(result.history).toEqual([
      { role: "user", text: "Follow-up" },
      { role: "assistant", text: "Recent answer" },
    ]);
    expect(openConversationFromSidebarWithRetry).not.toHaveBeenCalled();
  });

  test("readAttachedSupervisorThreadHistory reconstructs a project conversation URL when only the project root is configured", async () => {
    let currentReadCount = 0;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 0 } };
        }
        if (expression.includes("window.location.assign")) {
          return { result: { value: true } };
        }
        if (expression.includes("window.location.href") && expression.includes("historyWindow")) {
          return {
            result: {
              value: {
                thread: {
                  url: "https://chatgpt.com/g/team-space/c/target-9",
                  conversationId: "target-9",
                  title: "Target",
                  isActive: true,
                },
                history: [
                  { role: "user", text: "Follow-up" },
                  { role: "assistant", text: "Recent answer" },
                ],
                historyWindow: {
                  limit: 2,
                  returnedCount: 2,
                  totalCount: 2,
                  truncated: false,
                },
              },
            },
          };
        }
        if (expression.includes("const href = window.location.href || ''")) {
          currentReadCount += 1;
          return {
            result: {
              value:
                currentReadCount < 2
                  ? {
                      url: "https://chatgpt.com/g/team-space-oracle/c/current-1",
                      conversationId: "current-1",
                      title: "Current",
                      isActive: true,
                    }
                  : {
                      url: "https://chatgpt.com/g/team-space/c/target-9",
                      conversationId: "target-9",
                      title: "Target",
                      isActive: true,
                    },
            },
          };
        }
        throw new Error(`Unexpected expression: ${expression}`);
      }),
    } as unknown as ChromeClient["Runtime"];

    const result = await readAttachedSupervisorThreadHistory(runtime, {
      conversationId: "target-9",
      projectUrl,
      limit: 2,
    });

    expect(result.thread).toEqual({
      title: "Target",
      url: "https://chatgpt.com/g/team-space/c/target-9",
      conversationId: "target-9",
      isActive: true,
    });
    expect(result.history).toEqual([
      { role: "user", text: "Follow-up" },
      { role: "assistant", text: "Recent answer" },
    ]);
    expect(openConversationFromSidebarWithRetry).not.toHaveBeenCalled();
  });

  test("readAttachedSupervisorThreadHistory fails closed when the active thread changes during capture", async () => {
    let locationReads = 0;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 1 } };
        }
        if (expression.includes("window.location.href")) {
          locationReads += 1;
          return {
            result: {
              value:
                locationReads < 3
                  ? {
                      url: "https://chatgpt.com/c/current-9",
                      conversationId: "current-9",
                      title: "Current Chat",
                      isActive: true,
                    }
                  : {
                      url: "https://chatgpt.com/c/wrong-4",
                      conversationId: "wrong-4",
                      title: "Wrong Chat",
                      isActive: true,
                    },
            },
          };
        }
        return {
          result: {
            value: {
              history: [{ role: "assistant", text: "Recent answer" }],
              historyWindow: {
                limit: 1,
                returnedCount: 1,
                totalCount: 1,
                truncated: false,
              },
            },
          },
        };
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      readAttachedSupervisorThreadHistory(runtime, {
        conversationId: "current-9",
        limit: 1,
      }),
    ).rejects.toThrow("Oracle supervisor thread changed during history capture");
  });

  test("readAttachedSupervisorThreadHistory fails closed when the snapshot itself comes from the wrong thread", async () => {
    let locationReads = 0;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 1 } };
        }
        if (expression.includes("window.location.href") && expression.includes("historyWindow")) {
          return {
            result: {
              value: {
                thread: {
                  url: "https://chatgpt.com/c/wrong-4",
                  conversationId: "wrong-4",
                  title: "Wrong Chat",
                  isActive: true,
                },
                history: [{ role: "assistant", text: "Recent answer" }],
                historyWindow: {
                  limit: 1,
                  returnedCount: 1,
                  totalCount: 1,
                  truncated: false,
                },
              },
            },
          };
        }
        if (expression.includes("window.location.href")) {
          locationReads += 1;
          return {
            result: {
              value: {
                url: "https://chatgpt.com/c/current-9",
                conversationId: "current-9",
                title: "Current Chat",
                isActive: true,
              },
            },
          };
        }
        throw new Error(`Unexpected expression: ${expression}`);
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      readAttachedSupervisorThreadHistory(runtime, {
        conversationId: "current-9",
        limit: 1,
      }),
    ).rejects.toThrow("Oracle supervisor thread changed during history capture");
    expect(locationReads).toBeGreaterThan(0);
  });

  test("readAttachedSupervisorThreadHistory fails closed when history comes from an unvalidated secondary pane", async () => {
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 1 } };
        }
        if (expression.includes("window.location.href") && expression.includes("historyWindow")) {
          return {
            result: {
              value: {
                thread: {
                  url: "https://chatgpt.com/c/current-9",
                  conversationId: "current-9",
                  title: "Current Chat",
                  isActive: true,
                },
                history: [{ role: "assistant", text: "Secondary pane answer" }],
                historyWindow: {
                  limit: 1,
                  returnedCount: 1,
                  totalCount: 1,
                  truncated: false,
                },
                activeRootValidated: false,
              },
            },
          };
        }
        if (expression.includes("window.location.href")) {
          return {
            result: {
              value: {
                url: "https://chatgpt.com/c/current-9",
                conversationId: "current-9",
                title: "Current Chat",
                isActive: true,
              },
            },
          };
        }
        throw new Error(`Unexpected expression: ${expression}`);
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      readAttachedSupervisorThreadHistory(runtime, {
        conversationId: "current-9",
        limit: 1,
      }),
    ).rejects.toThrow("could not validate the active conversation container");
  });

  test("readAttachedSupervisorThreadHistory accepts legacy supervisorThread snapshot payloads", async () => {
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 1 } };
        }
        if (expression.includes("window.location.href") && expression.includes("historyWindow")) {
          return {
            result: {
              value: {
                supervisorThread: {
                  url: "https://chatgpt.com/c/current-9",
                  conversationId: "current-9",
                  title: "Current Chat",
                  isActive: true,
                },
                history: [{ role: "assistant", text: "Recent answer" }],
                historyWindow: {
                  limit: 1,
                  returnedCount: 1,
                  totalCount: 1,
                  truncated: false,
                },
              },
            },
          };
        }
        if (expression.includes("window.location.href")) {
          return {
            result: {
              value: {
                url: "https://chatgpt.com/c/current-9",
                conversationId: "current-9",
                title: "Current Chat",
                isActive: true,
              },
            },
          };
        }
        throw new Error(`Unexpected expression: ${expression}`);
      }),
    } as unknown as ChromeClient["Runtime"];

    const result = await readAttachedSupervisorThreadHistory(runtime, {
      conversationId: "current-9",
      limit: 1,
    });

    expect(result.thread.conversationId).toBe("current-9");
    expect(result.history).toEqual([{ role: "assistant", text: "Recent answer" }]);
  });

  test("readAttachedSupervisorThreadHistory fails closed when the requested conversation has no visible turns", async () => {
    vi.mocked(openConversationFromSidebarWithRetry).mockResolvedValue(true);
    let now = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 3_000;
      return now;
    });
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("return __oracleCollectThreadEntries(activeRoot).filter(")) {
          return { result: { value: 0 } };
        }
        if (expression.includes("window.location.assign")) {
          return { result: { value: true } };
        }
        if (expression.includes("const turnSelector =")) {
          return {
            result: {
              value: {
                thread: {
                  url: "https://chatgpt.com/g/team-space-oracle/c/current-9",
                  conversationId: "current-9",
                  title: "ChatGPT",
                  isActive: true,
                },
                history: [],
                historyWindow: {
                  limit: 1,
                  returnedCount: 0,
                  totalCount: 0,
                  truncated: false,
                },
                activeRootValidated: false,
              },
            },
          };
        }
        if (expression.includes("const href = window.location.href || ''")) {
          return {
            result: {
              value: {
                url: "https://chatgpt.com/g/team-space-oracle/c/current-9",
                conversationId: "current-9",
                title: "ChatGPT",
                isActive: true,
              },
            },
          };
        }
        throw new Error(`Unexpected expression: ${expression}`);
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      readAttachedSupervisorThreadHistory(runtime, {
        conversationId: "current-9",
        projectUrl,
        limit: 1,
      }),
    ).rejects.toThrow("could not validate the active conversation container");
    dateNow.mockRestore();
  });

  test("attach_thread fails when the requested conversation never becomes active", async () => {
    vi.mocked(openConversationFromSidebarWithRetry).mockResolvedValue(true);
    let now = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 3_000;
      return now;
    });
    const evaluate = vi.fn(async () => ({
      result: {
        value: {
          url: "https://chatgpt.com/c/current-1",
          conversationId: "current-1",
          title: "Current",
          isActive: true,
        },
      },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    await expect(attachSupervisorThread(runtime, "target-9")).rejects.toThrow(
      "Conversation target-9 did not become active after attach_thread",
    );
    dateNow.mockRestore();
  });

  test("project scope matcher accepts only the configured project root or its conversations", () => {
    expect(
      __test__.supervisorThreadMatchesProjectScope(
        {
          title: "Fresh",
          url: projectUrl,
          conversationId: undefined,
          isActive: true,
        },
        projectUrl,
      ),
    ).toBe(true);
    expect(
      __test__.supervisorThreadMatchesProjectScope(
        {
          title: "Scoped conversation",
          url: "https://chatgpt.com/g/team-space-oracle/c/right-thread",
          conversationId: "right-thread",
          isActive: true,
        },
        projectUrl,
      ),
    ).toBe(true);
    expect(
      __test__.supervisorThreadMatchesProjectScope(
        {
          title: "Root chat",
          url: "https://chatgpt.com/c/root-thread",
          conversationId: "root-thread",
          isActive: true,
        },
        projectUrl,
      ),
    ).toBe(false);
    expect(
      __test__.supervisorThreadMatchesProjectScope(
        {
          title: "Different project with shared prefix",
          url: "https://chatgpt.com/g/team-space-other/c/root-thread",
          conversationId: "root-thread",
          isActive: true,
        },
        projectUrl,
      ),
    ).toBe(false);
  });

  test("project scope matcher accepts project-shell query and hash variants", () => {
    expect(
      __test__.supervisorThreadMatchesProjectScope(
        {
          title: "Fresh",
          url: "https://chatgpt.com/g/team-space/project?model=gpt-5.4#top",
          conversationId: undefined,
          isActive: true,
        },
        projectUrl,
      ),
    ).toBe(true);
  });

  test("project-scoped listing keeps conversation rows that only expose a conversation id", async () => {
    const runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: [
            {
              title: "Sidebar thread",
              conversationId: "thread-from-sidebar",
            },
            {
              title: "Other project",
              url: "https://chatgpt.com/g/other-space-oracle/c/other-thread",
              conversationId: "other-thread",
            },
          ],
        },
      })),
    } as unknown as ChromeClient["Runtime"];

    const threads = await listSupervisorThreads(runtime, {
      projectUrl,
    });

    expect(threads).toEqual([
      {
        title: "Sidebar thread",
        conversationId: "thread-from-sidebar",
        isActive: false,
      },
    ]);
  });

  test("new_thread returns immediately when already on a fresh chat", async () => {
    const evaluate = vi.fn(async () => ({
      result: {
        value: {
          url: "https://chatgpt.com/",
          conversationId: "",
          title: "ChatGPT",
          isActive: true,
        },
      },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const thread = await newSupervisorThread(runtime);

    expect(thread).toEqual({
      title: "ChatGPT",
      url: "https://chatgpt.com/",
      conversationId: undefined,
      isActive: true,
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  test("new_thread accepts a fresh chat even when the URL stays the same", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          value: {
            url: "https://chatgpt.com/c/current-1",
            conversationId: "current-1",
            title: "Current",
            isActive: true,
          },
        },
      })
      .mockResolvedValueOnce({ result: { value: true } })
      .mockResolvedValue({
        result: {
          value: {
            url: "https://chatgpt.com/",
            conversationId: "",
            title: "ChatGPT",
            isActive: true,
          },
        },
      });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const thread = await newSupervisorThread(runtime);

    expect(thread).toEqual({
      title: "ChatGPT",
      url: "https://chatgpt.com/",
      conversationId: undefined,
      isActive: true,
    });
  });

  test("new_thread treats a configured project root as a fresh chat", async () => {
    const evaluate = vi.fn(async () => ({
      result: {
        value: {
          url: "https://chatgpt.com/g/team-space/project",
          conversationId: "",
          title: "Workspace",
          isActive: true,
        },
      },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const thread = await newSupervisorThread(runtime, {
      projectUrl: "https://chatgpt.com/g/team-space/project",
    });

    expect(thread).toEqual({
      title: "Workspace",
      url: "https://chatgpt.com/g/team-space/project",
      conversationId: undefined,
      isActive: true,
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  test("new_thread falls back to the configured project URL instead of the ChatGPT root", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          value: {
            url: "https://chatgpt.com/c/current-1",
            conversationId: "current-1",
            title: "Current",
            isActive: true,
          },
        },
      })
      .mockResolvedValueOnce({ result: { value: true } })
      .mockResolvedValue({
        result: {
          value: {
            url: "https://chatgpt.com/g/team-space/project",
            conversationId: "",
            title: "Workspace",
            isActive: true,
          },
        },
      });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const thread = await newSupervisorThread(runtime, {
      projectUrl: "https://chatgpt.com/g/team-space/project",
    });

    expect(thread).toEqual({
      title: "Workspace",
      url: "https://chatgpt.com/g/team-space/project",
      conversationId: undefined,
      isActive: true,
    });
    expect(evaluate.mock.calls[1]?.[0]?.expression).toContain(
      'window.location.href = "https://chatgpt.com/g/team-space/project"',
    );
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  test("new_thread keeps waiting when navigation changes to an out-of-scope destination first", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          value: {
            url: "https://chatgpt.com/g/team-space/c/current-1",
            conversationId: "current-1",
            title: "Current",
            isActive: true,
          },
        },
      })
      .mockResolvedValueOnce({ result: { value: true } })
      .mockResolvedValueOnce({
        result: {
          value: {
            url: "https://chatgpt.com/",
            conversationId: "",
            title: "Root chat",
            isActive: true,
          },
        },
      })
      .mockResolvedValue({
        result: {
          value: {
            url: "https://chatgpt.com/g/team-space/project",
            conversationId: "",
            title: "Workspace",
            isActive: true,
          },
        },
      });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const thread = await newSupervisorThread(runtime, {
      projectUrl,
    });

    expect(thread).toEqual({
      title: "Workspace",
      url: "https://chatgpt.com/g/team-space/project",
      conversationId: undefined,
      isActive: true,
    });
    expect(evaluate).toHaveBeenCalledTimes(4);
  });
});
