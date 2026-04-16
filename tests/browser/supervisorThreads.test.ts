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

describe("supervisorThreads", () => {
  const projectUrl = "https://chatgpt.com/g/team-space/project";

  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(openConversationFromSidebarWithRetry).toHaveBeenCalledWith(
      runtime,
      { conversationId: "target-9", preferProjects: true },
      15_000,
    );
    expect(thread).toEqual({
      title: "Target",
      url: "https://chatgpt.com/g/team-space/c/target-9",
      conversationId: "target-9",
      isActive: true,
    });
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
    ).rejects.toThrow("Conversation current-9 did not become active after attach_thread");
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
