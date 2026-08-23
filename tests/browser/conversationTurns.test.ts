import { describe, expect, test, vi } from "vitest";
import {
  captureConversationUserTurnBinding,
  captureLatestConversationUserTurnBinding,
  hashConversationTurnText,
  readBoundConversationTurn,
  resolveConversationUserTurnBinding,
} from "../../src/browser/conversationTurns.js";
import type { ChromeClient } from "../../src/browser/types.js";

describe("conversation turn affinity", () => {
  test("distinguishes prompts that share the same preview prefix", () => {
    const prefix = "Review this exact candidate ".repeat(12);
    const first = `${prefix}alpha`;
    const second = `${prefix}beta`;
    const turns = [
      { index: 2, text: first, turnId: "turn-2", messageId: "message-2" },
      { index: 4, text: second, turnId: "turn-4", messageId: "message-4" },
    ];

    expect(
      resolveConversationUserTurnBinding(
        { promptDigest: hashConversationTurnText(second), promptTurnIndex: 4 },
        turns,
      ),
    ).toEqual({ status: "matched", user: turns[1] });
    expect(
      resolveConversationUserTurnBinding(
        { promptDigest: hashConversationTurnText(first), promptTurnIndex: 4 },
        turns,
      ),
    ).toEqual({ status: "missing" });
  });

  test("fails closed when a digest alone matches repeated user turns", () => {
    const text = "repeat this exact prompt";
    expect(
      resolveConversationUserTurnBinding({ promptDigest: hashConversationTurnText(text) }, [
        { index: 0, text },
        { index: 2, text },
      ]),
    ).toEqual({ status: "ambiguous" });
  });

  test("captures the last committed user turn with full-text digest and DOM ids", async () => {
    const Runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: [
            { index: 0, text: "first" },
            { index: 3, text: "second full prompt", turnId: "turn-3", messageId: "message-3" },
          ],
        },
      })),
    } as unknown as ChromeClient["Runtime"];

    await expect(captureLatestConversationUserTurnBinding(Runtime, 1)).resolves.toEqual({
      promptDigest: hashConversationTurnText("second full prompt"),
      promptTurnIndex: 3,
      promptTurnId: "turn-3",
      promptMessageId: "message-3",
    });
  });

  test("captures the only new user turn that contains the exact submitted prompt", async () => {
    const prompt = "Review this `exact` candidate";
    const Runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: [
            { index: 0, text: prompt, messageId: "old-message" },
            {
              index: 4,
              text: `attachments-bundle.txt Document\nReview this exact candidate`,
              turnId: "turn-4",
              messageId: "message-4",
            },
          ],
        },
      })),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      captureConversationUserTurnBinding(Runtime, prompt, 2, {
        expectedTurnIndex: 4,
        attachmentNames: ["attachments-bundle.txt"],
      }),
    ).resolves.toEqual({
      promptDigest: hashConversationTurnText(
        "attachments-bundle.txt Document\nReview this exact candidate",
      ),
      promptTurnIndex: 4,
      promptTurnId: "turn-4",
      promptMessageId: "message-4",
    });
  });

  test.each([
    `prefix before Review this exact candidate suffix after`,
    `Review this exact candidate plus an unrelated request`,
  ])("rejects a different turn that only embeds the submitted prompt", async (rendered) => {
    const Runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: [{ index: 4, text: rendered, turnId: "turn-4", messageId: "message-4" }],
        },
      })),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      captureConversationUserTurnBinding(Runtime, "Review this exact candidate", 2, {
        expectedTurnIndex: 4,
      }),
    ).resolves.toBeNull();
  });

  test("requires the provisional turn index when one was persisted", async () => {
    const Runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: [{ index: 4, text: "exact prompt", turnId: "turn-4", messageId: "message-4" }],
        },
      })),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      captureConversationUserTurnBinding(Runtime, "exact prompt", 0, { expectedTurnIndex: 2 }),
    ).resolves.toBeNull();
  });

  test("captures the exact inline prompt with attachment contents", async () => {
    const prompt = "Read the attached package and return its package manager";
    const rendered = `${prompt}\n\n### File: package.json\n\`\`\`json\n{"packageManager":"pnpm@11.7.0"}\n\`\`\``;
    const Runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: [{ index: 0, text: rendered, turnId: "turn-0", messageId: "message-0" }],
        },
      })),
    } as unknown as ChromeClient["Runtime"];

    await expect(captureConversationUserTurnBinding(Runtime, rendered)).resolves.toEqual({
      promptDigest: hashConversationTurnText(rendered),
      promptTurnIndex: 0,
      promptTurnId: "turn-0",
      promptMessageId: "message-0",
    });
  });

  test("does not upgrade an older decorated turn when no baseline was persisted", async () => {
    const Runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: [
            {
              index: 0,
              text: "Review this candidate\n\n### File: stale.txt\nstale contents",
              turnId: "turn-0",
              messageId: "message-0",
            },
          ],
        },
      })),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      captureConversationUserTurnBinding(Runtime, "Review this candidate"),
    ).resolves.toBeNull();
  });

  test("fails closed when more than one new user turn matches the submitted prompt", async () => {
    const Runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: [
            { index: 2, text: "same prompt" },
            { index: 4, text: "same prompt" },
          ],
        },
      })),
    } as unknown as ChromeClient["Runtime"];

    await expect(captureConversationUserTurnBinding(Runtime, "same prompt", 2)).resolves.toBeNull();
  });

  test("resolves the stored user and assistant branch from one DOM snapshot", async () => {
    const Runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: [
            {
              user: {
                index: 0,
                text: "parent prompt",
                turnId: "user-turn",
                messageId: "user-message",
              },
              assistants: [
                {
                  index: 1,
                  text: "selected answer",
                  turnId: "assistant-turn",
                  messageId: "assistant-message",
                  completionVisible: true,
                },
                {
                  index: 1,
                  text: "regenerated answer",
                  turnId: "assistant-turn-regenerated",
                  messageId: "assistant-message-regenerated",
                },
              ],
              hasLaterUserTurn: true,
            },
          ],
        },
      })),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      readBoundConversationTurn(Runtime, {
        promptDigest: hashConversationTurnText("parent prompt"),
        promptTurnIndex: 0,
        promptTurnId: "user-turn",
        promptMessageId: "user-message",
        assistantTurnIndex: 1,
        assistantTurnId: "assistant-turn",
        assistantMessageId: "assistant-message",
      }),
    ).resolves.toEqual({
      status: "matched",
      turn: {
        user: {
          index: 0,
          text: "parent prompt",
          turnId: "user-turn",
          messageId: "user-message",
        },
        assistant: {
          index: 1,
          text: "selected answer",
          turnId: "assistant-turn",
          messageId: "assistant-message",
          completionVisible: true,
        },
        hasLaterUserTurn: true,
      },
    });
    expect(Runtime.evaluate).toHaveBeenCalledOnce();
  });

  test("fails closed when a bound user turn has multiple unbound assistant branches", async () => {
    const Runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: [
            {
              user: { index: 0, text: "prompt", messageId: "prompt-message" },
              assistants: [
                { index: 1, text: "first branch", messageId: "assistant-1" },
                { index: 1, text: "regenerated branch", messageId: "assistant-2" },
              ],
              hasLaterUserTurn: false,
            },
          ],
        },
      })),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      readBoundConversationTurn(Runtime, { promptMessageId: "prompt-message" }),
    ).resolves.toEqual({ status: "ambiguous" });
  });

  test("fails closed when the rendered assistant is not the stored branch", async () => {
    const Runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: [
            {
              user: { index: 0, text: "prompt", messageId: "prompt-message" },
              assistants: [
                {
                  index: 1,
                  text: "different branch",
                  messageId: "different-assistant-message",
                },
              ],
              hasLaterUserTurn: false,
            },
          ],
        },
      })),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      readBoundConversationTurn(Runtime, {
        promptMessageId: "prompt-message",
        assistantMessageId: "stored-assistant-message",
      }),
    ).resolves.toEqual({ status: "missing" });
  });
});
