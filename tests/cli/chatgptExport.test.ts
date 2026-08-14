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
  const ws = (browserId: string, host = "127.0.0.1", port = 9223) =>
    `ws://${host}:${port}/devtools/browser/${browserId}`;
  const config = (host: string, port: number, browserId: string) => ({
    remoteChrome: { host, port },
    remoteChromeBrowserId: browserId,
    remoteChromeBrowserWSEndpoint: ws(browserId, host, port),
  });
  const affinity = (host: string, port: number, browserId: string) => ({
    host,
    port,
    browserId,
    browserWSEndpoint: ws(browserId, host, port),
  });

  test("matches a root target URL to project conversation evidence", () => {
    expect(
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-1", [
        session("project", {
          config: {
            url: "https://chatgpt.com/g/g-project/c/thread-1",
            ...config("127.0.0.1", 9223, "browser-a"),
          },
        }),
      ]),
    ).toEqual(affinity("127.0.0.1", 9223, "browser-a"));
  });

  test("matches stored conversation ids when no conversation URL is available", () => {
    expect(
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-id-only", [
        session("stored-id", {
          runtime: { conversationId: "thread-id-only" },
          config: config("127.0.0.1", 9228, "browser-a"),
        }),
      ]),
    ).toEqual(affinity("127.0.0.1", 9228, "browser-a"));
  });

  test("deduplicates a parent and follow-up stored on the same browser affinity", () => {
    const browserConfig = config("127.0.0.1", 9224, "browser-a");
    expect(
      resolveChatGptExportRemoteChrome("https://chatgpt.com/g/g-project/c/thread-2", [
        session("parent", {
          harvest: { url: "https://chatgpt.com/c/thread-2" },
          config: browserConfig,
        }),
        session(
          "follow-up",
          { config: browserConfig },
          { browserResumeConversationUrl: "https://chatgpt.com/c/thread-2" },
        ),
      ]),
    ).toEqual(affinity("127.0.0.1", 9224, "browser-a"));
  });

  test("deduplicates equivalent endpoint hostnames case-insensitively", () => {
    expect(
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-host-case", [
        session("uppercase", {
          harvest: { conversationId: "thread-host-case" },
          config: config("Chrome.EXAMPLE", 9223, "browser-a"),
        }),
        session("lowercase", {
          harvest: { conversationId: "thread-host-case" },
          config: config("chrome.example", 9223, "browser-a"),
        }),
      ]),
    ).toEqual(affinity("chrome.example", 9223, "browser-a"));
  });

  test("prefers the runtime browser WebSocket and derives legacy browser ids", () => {
    const browserWSEndpoint = ws("browser-a", "127.0.0.1", 9229);
    expect(
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-runtime", [
        session("runtime", {
          harvest: { conversationId: "thread-runtime" },
          config: { remoteChrome: { host: "127.0.0.1", port: 9229 } },
          runtime: { chromeBrowserWSEndpoint: browserWSEndpoint },
        }),
      ]),
    ).toEqual({
      host: "127.0.0.1",
      port: 9229,
      browserId: "browser-a",
      browserWSEndpoint,
    });
  });

  test("fails closed when no session matches the target conversation", () => {
    expect(() =>
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-3", [
        session("other", {
          config: {
            url: "https://chatgpt.com/c/other-thread",
            ...config("127.0.0.1", 9225, "browser-a"),
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

  test("preserves raw stored endpoints outside the wrapper", () => {
    expect(
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-host-only", [
        session("host-only", {
          harvest: { conversationId: "thread-host-only" },
          config: { remoteChrome: { host: "127.0.0.1", port: 9223 } },
        }),
      ]),
    ).toEqual({ host: "127.0.0.1", port: 9223 });
  });

  test("fails closed for wrapper-routed sessions with only host and port", () => {
    const previous = process.env.ORACLE_WRAPPER_REMOTE_ONLY;
    process.env.ORACLE_WRAPPER_REMOTE_ONLY = "1";
    try {
      expect(() =>
        resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-host-only", [
          session("host-only", {
            harvest: { conversationId: "thread-host-only" },
            config: { remoteChrome: { host: "127.0.0.1", port: 9223 } },
          }),
        ]),
      ).toThrow(/browser identity is unavailable/i);
    } finally {
      if (previous === undefined) {
        delete process.env.ORACLE_WRAPPER_REMOTE_ONLY;
      } else {
        process.env.ORACLE_WRAPPER_REMOTE_ONLY = previous;
      }
    }
  });

  test("fails closed when configured and runtime browser identities conflict", () => {
    expect(() =>
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-identity-conflict", [
        session("identity-conflict", {
          harvest: { conversationId: "thread-identity-conflict" },
          config: config("127.0.0.1", 9223, "browser-a"),
          runtime: { chromeBrowserWSEndpoint: ws("browser-b") },
        }),
      ]),
    ).toThrow(/browser identity is conflicting/i);
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

  test("rejects conflicting browser affinities across matching sessions", () => {
    expect(() =>
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-5", [
        session("parent", {
          runtime: { tabUrl: "https://chatgpt.com/c/thread-5" },
          config: config("127.0.0.1", 9226, "browser-a"),
        }),
        session("follow-up", undefined, {
          browserConfig: {
            resumeConversationUrl: "https://chatgpt.com/c/thread-5",
            ...config("127.0.0.1", 9227, "browser-b"),
          },
        }),
      ]),
    ).toThrow(/conflicting stored remote Chrome browser affinities/i);
  });

  test("rejects a browser restart on the same host and port", () => {
    expect(() =>
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-restarted", [
        session("before-restart", {
          harvest: { conversationId: "thread-restarted" },
          config: config("127.0.0.1", 9223, "browser-a"),
        }),
        session("after-restart", {
          harvest: { conversationId: "thread-restarted" },
          config: config("127.0.0.1", 9223, "browser-b"),
        }),
      ]),
    ).toThrow(/conflicting stored remote Chrome browser affinities/i);
  });
});
