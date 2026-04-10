import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  __test__,
  attachSupervisorThread,
  listSupervisorThreads,
  newSupervisorThread,
  readCurrentSupervisorThread,
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

  test("attach_thread waits until the requested conversation is active", async () => {
    vi.mocked(openConversationFromSidebarWithRetry).mockResolvedValue(true);
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
      .mockResolvedValueOnce({
        result: {
          value: {
            url: "https://chatgpt.com/c/target-9",
            conversationId: "target-9",
            title: "Target",
            isActive: true,
          },
        },
      });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const thread = await attachSupervisorThread(runtime, "target-9");

    expect(openConversationFromSidebarWithRetry).toHaveBeenCalledWith(
      runtime,
      { conversationId: "target-9", preferProjects: true },
      15_000,
    );
    expect(thread).toEqual({
      title: "Target",
      url: "https://chatgpt.com/c/target-9",
      conversationId: "target-9",
      isActive: true,
    });
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

  test("new_thread does not treat project pages as already-fresh chats", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          value: {
            url: "https://chatgpt.com/g/team-space",
            conversationId: "",
            title: "Workspace",
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
    expect(evaluate).toHaveBeenCalledTimes(3);
  });
});
