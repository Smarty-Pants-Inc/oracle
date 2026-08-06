import { afterEach, describe, expect, test, vi } from "vitest";
import type { CommittedPromptEpochLocator } from "../../src/browser/reattachability.js";

const { readAssistantSnapshot } = vi.hoisted(() => ({
  readAssistantSnapshot: vi.fn(),
}));

vi.mock("../../src/browser/pageActions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/browser/pageActions.js")>()),
  readAssistantSnapshot,
}));

import {
  normalizeForComparison,
  waitForFreshAssistantResponse,
} from "../../src/browser/responseCaptureCoordinator.js";

const expectedPromptTurn = {
  verifiedUserTurnIndex: 4,
  conversationId: "conversation-id",
} as CommittedPromptEpochLocator;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("fresh assistant response capture", () => {
  test("normalizes case and whitespace before comparing responses", () => {
    expect(normalizeForComparison("  Answer\n\tWith   Spaces  ")).toBe("answer with spaces");
  });

  test("ignores a normalized baseline snapshot before returning a fresh response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    readAssistantSnapshot
      .mockResolvedValueOnce({ text: "  Previous\nanswer  " })
      .mockResolvedValueOnce({
        text: "  Fresh answer  ",
        html: "<p>Fresh answer</p>",
        turnId: "turn-id",
        messageId: "message-id",
      });

    const capture = waitForFreshAssistantResponse(
      {} as never,
      normalizeForComparison("Previous answer"),
      15_000,
      expectedPromptTurn,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(350);

    await expect(capture).resolves.toEqual({
      text: "Fresh answer",
      html: "<p>Fresh answer</p>",
      meta: { turnId: "turn-id", messageId: "message-id" },
    });
    expect(readAssistantSnapshot).toHaveBeenNthCalledWith(
      1,
      {},
      5,
      "conversation-id",
      expectedPromptTurn,
    );
  });

  test("returns null at the deadline after only baseline snapshots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    readAssistantSnapshot.mockResolvedValue({ text: "Previous answer" });

    const capture = waitForFreshAssistantResponse(
      {} as never,
      normalizeForComparison("Previous answer"),
      700,
      expectedPromptTurn,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(700);

    await expect(capture).resolves.toBeNull();
    expect(readAssistantSnapshot).toHaveBeenCalledTimes(2);
  });
});
