import { describe, expect, test } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";
import {
  handleChatGptExportCommand,
  parseRemoteChromeTarget,
  resolveChatGptExportRemoteChrome,
} from "../../src/cli/chatgptExport.js";

function session(
  id: string,
  browser: SessionMetadata["browser"],
  options: SessionMetadata["options"] = {},
): SessionMetadata {
  return {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    options,
    browser,
  };
}

describe("ChatGPT export endpoint affinity", () => {
  test("matches a root target URL to project conversation evidence", () => {
    expect(
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-1", [
        session("project", {
          config: {
            url: "https://chatgpt.com/g/g-project/c/thread-1",
            remoteChrome: { host: "127.0.0.1", port: 9223 },
          },
        }),
      ]),
    ).toEqual({ host: "127.0.0.1", port: 9223 });
  });

  test("matches stored conversation ids when no conversation URL is available", () => {
    expect(
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-id-only", [
        session("stored-id", {
          runtime: { conversationId: "thread-id-only" },
          config: { remoteChrome: { host: "127.0.0.1", port: 9228 } },
        }),
      ]),
    ).toEqual({ host: "127.0.0.1", port: 9228 });
  });

  test("deduplicates a parent and follow-up stored on the same endpoint", () => {
    const endpoint = { host: "127.0.0.1", port: 9224 };
    expect(
      resolveChatGptExportRemoteChrome("https://chatgpt.com/g/g-project/c/thread-2", [
        session("parent", {
          harvest: { url: "https://chatgpt.com/c/thread-2" },
          config: { remoteChrome: endpoint },
        }),
        session(
          "follow-up",
          { config: { remoteChrome: endpoint } },
          { browserResumeConversationUrl: "https://chatgpt.com/c/thread-2" },
        ),
      ]),
    ).toEqual(endpoint);
  });

  test("deduplicates equivalent endpoint hostnames case-insensitively", () => {
    expect(
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-host-case", [
        session("uppercase", {
          harvest: { conversationId: "thread-host-case" },
          config: { remoteChrome: { host: "Chrome.EXAMPLE", port: 9223 } },
        }),
        session("lowercase", {
          harvest: { conversationId: "thread-host-case" },
          config: { remoteChrome: { host: "chrome.example", port: 9223 } },
        }),
      ]),
    ).toEqual({ host: "chrome.example", port: 9223 });
  });

  test("fails closed when no session matches the target conversation", () => {
    expect(() =>
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-3", [
        session("other", {
          config: {
            url: "https://chatgpt.com/c/other-thread",
            remoteChrome: { host: "127.0.0.1", port: 9225 },
          },
        }),
      ]),
    ).toThrow(/no stored browser session matches/i);
  });

  test("fails closed when a matching session has no endpoint", () => {
    expect(() =>
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-4", [
        session("missing-endpoint", {
          archive: {
            mode: "never",
            attempted: false,
            archived: false,
            conversationUrl: "https://chatgpt.com/c/thread-4",
          },
        }),
      ]),
    ).toThrow(/no stored remote Chrome endpoint/i);
  });

  test("fails closed for malformed stored endpoints", () => {
    expect(() =>
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-invalid-endpoint", [
        session("invalid-endpoint", {
          harvest: { conversationId: "thread-invalid-endpoint" },
          config: { remoteChrome: { host: " ", port: 0 } },
        }),
      ]),
    ).toThrow(/stored remote Chrome endpoint is invalid/i);
  });

  test.each(["", "127.0.0.1:9223junk", "127.0.0.1:9223.5"])(
    "rejects malformed explicit remote Chrome value %j",
    (value) => {
      expect(() => parseRemoteChromeTarget(value)).toThrow(/invalid remote-chrome/i);
    },
  );

  test("accepts exact raw CLI remote Chrome targets", () => {
    expect(parseRemoteChromeTarget("127.0.0.1:9223")).toEqual({
      host: "127.0.0.1",
      port: 9223,
    });
  });

  test("rejects explicit export endpoints under the agent wrapper contract", async () => {
    const previous = process.env.ORACLE_WRAPPER_REMOTE_ONLY;
    process.env.ORACLE_WRAPPER_REMOTE_ONLY = "1";
    try {
      await expect(
        handleChatGptExportCommand({
          targetUrl: "https://chatgpt.com/c/thread-wrapper",
          remoteChrome: "127.0.0.1:9223",
        }),
      ).rejects.toThrow(/stored session affinity/i);
    } finally {
      if (previous === undefined) {
        delete process.env.ORACLE_WRAPPER_REMOTE_ONLY;
      } else {
        process.env.ORACLE_WRAPPER_REMOTE_ONLY = previous;
      }
    }
  });
  test("rejects conflicting endpoints across matching sessions", () => {
    expect(() =>
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-5", [
        session("parent", {
          runtime: { tabUrl: "https://chatgpt.com/c/thread-5" },
          config: { remoteChrome: { host: "127.0.0.1", port: 9226 } },
        }),
        session("follow-up", undefined, {
          browserConfig: {
            resumeConversationUrl: "https://chatgpt.com/c/thread-5",
            remoteChrome: { host: "127.0.0.1", port: 9227 },
          },
        }),
      ]),
    ).toThrow(/conflicting stored remote Chrome endpoints/i);
  });
});
