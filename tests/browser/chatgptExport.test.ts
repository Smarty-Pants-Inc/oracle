import { describe, expect, test } from "vitest";
import {
  backendToPayload,
  buildBackendConversationUrl,
  buildScopedBackendCaptureHook,
  contentToText,
  conversationIdFromChatGptUrl,
  isSameConversationUrl,
  retrieveCapturedTextWithEvaluator,
  scanTextForSecretLikeMarkers,
} from "../../src/browser/chatgptExport.js";

describe("ChatGPT conversation export helpers", () => {
  test("accepts only exact chatgpt.com conversation URLs", () => {
    expect(conversationIdFromChatGptUrl("https://chatgpt.com/c/abc-123")).toBe("abc-123");
    expect(conversationIdFromChatGptUrl("https://chatgpt.com/c/abc-123/")).toBe("abc-123");
    expect(conversationIdFromChatGptUrl("https://chatgpt.com/g/project-1/c/abc-123")).toBe(
      "abc-123",
    );
    expect(conversationIdFromChatGptUrl("https://chatgpt.com/g/g-p-123/c/abc-123/")).toBe(
      "abc-123",
    );
    expect(() => conversationIdFromChatGptUrl("https://chat.openai.com/c/abc")).toThrow(
      /chatgpt\.com\/c/,
    );
    expect(() => conversationIdFromChatGptUrl("https://chatgpt.com/")).toThrow(/specific/i);
    expect(() => conversationIdFromChatGptUrl("https://chatgpt.com/g/example/project")).toThrow(
      /specific/i,
    );
  });

  test("derives exact backend conversation URL and scope check", () => {
    expect(buildBackendConversationUrl("conv-1")).toBe(
      "https://chatgpt.com/backend-api/conversation/conv-1",
    );
    expect(isSameConversationUrl("https://chatgpt.com/c/conv-1", "conv-1")).toBe(true);
    expect(isSameConversationUrl("https://chatgpt.com/g/project/c/conv-1", "conv-1")).toBe(true);
    expect(isSameConversationUrl("https://chatgpt.com/c/other", "conv-1")).toBe(false);
    expect(isSameConversationUrl("https://chatgpt.com/g/project/c/other", "conv-1")).toBe(false);
    expect(isSameConversationUrl("https://chatgpt.com/", "conv-1")).toBe(false);
  });

  test("capture hook scopes recording to one backend URL", () => {
    const hook = buildScopedBackendCaptureHook(
      "https://chatgpt.com/backend-api/conversation/conv-1",
    );
    expect(hook).toContain('const TARGET = "https://chatgpt.com/backend-api/conversation/conv-1"');
    expect(hook).toContain("url !== TARGET");
    expect(hook).toContain("window.fetch");
    expect(hook).toContain("XMLHttpRequest");
    expect(hook).toContain(
      'sessionStorage.setItem("__oracleChatGptBackendCapture:" + TARGET, text)',
    );
    expect(hook).not.toContain("localStorage");
    expect(hook).not.toContain("cookie");
  });

  test("retrieves persisted capture text after a transient miss", async () => {
    const payload = '{"ok":true}';
    let attempts = 0;
    const result = await retrieveCapturedTextWithEvaluator(
      async (expression) => {
        expect(expression).toContain(
          'sessionStorage.getItem("__oracleChatGptBackendCapture:" + target)',
        );
        attempts += 1;
        return (attempts === 1 ? null : payload) as never;
      },
      "https://chatgpt.com/backend-api/conversation/conv-1",
      payload.length,
      payload.length,
    );
    expect(result).toBe(payload);
    expect(attempts).toBe(2);
  });

  test("normalizes backend content types without losing structured values", () => {
    expect(contentToText({ content_type: "text", parts: ["hello", { ok: true }] })).toContain(
      "hello",
    );
    expect(contentToText({ content_type: "code", text: "print(1)" })).toBe("print(1)");
    expect(contentToText({ content_type: "execution_output", text: "done" })).toBe("done");
    expect(contentToText({ content_type: "reasoning_recap", content: "summary" })).toBe("summary");
    expect(
      contentToText({ content_type: "thoughts", thoughts: [{ text: "visible thought" }] }),
    ).toContain("visible thought");
  });

  test("scans exported text for secret-like markers without treating marker mentions as findings", () => {
    expect(scanTextForSecretLikeMarkers("conversation.md", "OPENAI_API_KEY")).toMatchObject({
      findings: [],
      warnings: [
        "marker mention present in conversation.md: OPENAI_API_KEY",
        "marker mention present in conversation.md: API_KEY",
      ],
    });
    expect(scanTextForSecretLikeMarkers("conversation.md", "TOKEN=abc123").findings).toEqual([
      { path: "conversation.md", marker: "TOKEN assignment" },
    ]);
  });

  test("converts current-node path to normalized payload stats", () => {
    const payload = backendToPayload(
      {
        title: "Thread",
        conversation_id: "conv-1",
        current_node: "assistant-1",
        mapping: {
          root: {
            id: "root",
            parent: null,
            children: ["user-1"],
            message: null,
          },
          "user-1": {
            id: "user-1",
            parent: "root",
            children: ["assistant-1"],
            message: {
              id: "msg-user",
              author: { role: "user" },
              content: { content_type: "text", parts: ["Question"] },
              metadata: {},
            },
          },
          "assistant-1": {
            id: "assistant-1",
            parent: "user-1",
            children: [],
            message: {
              id: "msg-assistant",
              author: { role: "assistant" },
              content: { content_type: "text", parts: ["Answer"] },
              metadata: {
                attachments: [{ name: "notes.txt", download_url: "https://example.test" }],
              },
            },
          },
        },
      },
      "https://chatgpt.com/c/conv-1",
      "sha",
      123,
    );

    expect(payload.scope_ok).toBe(true);
    expect(payload.stats).toMatchObject({
      turn_count: 2,
      user_turns: 1,
      assistant_turns: 1,
      mapping_node_count: 3,
      current_path_node_count: 3,
      asset_candidates: 1,
    });
    expect(payload.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "Question" }),
        expect.objectContaining({ role: "assistant", text: "Answer" }),
      ]),
    );
  });
});
