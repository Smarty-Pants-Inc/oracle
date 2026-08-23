import { describe, expect, test } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";
import {
  handleChatGptExportCommand,
  parseRemoteChromeTarget,
  resolveChatGptExportRemoteChrome,
  resolveChatGptExportRemoteChromeForSession,
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
  const accountDigest = "a".repeat(64);
  const config = (host: string, port: number, browserId: string) => ({
    remoteChrome: { host, port },
    remoteChromeBrowserId: browserId,
    remoteChromeBrowserWSEndpoint: ws(browserId, host, port),
    remoteChromeAccountDigest: accountDigest,
  });
  const affinity = (host: string, port: number, browserId: string) => ({
    host,
    port,
    browserId,
    browserWSEndpoint: ws(browserId, host, port),
    accountDigest,
  });

  test.each([
    { sessionId: "   ", label: "--session-id" },
    { obuTabId: "", label: "--obu-tab-id" },
  ])("rejects an explicitly empty $label selector", async ({ label, ...selector }) => {
    await expect(
      handleChatGptExportCommand({
        targetUrl: "https://chatgpt.com/c/thread-empty-selector",
        ...selector,
      }),
    ).rejects.toThrow(new RegExp(`${label} cannot be empty`, "i"));
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

  test("rejects conflicting stored conversation identities", () => {
    expect(() =>
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-conflict", [
        session("conflicting", {
          harvest: { conversationId: "thread-conflict" },
          runtime: { conversationId: "different-thread" },
          config: config("127.0.0.1", 9223, "browser-a"),
        }),
      ]),
    ).toThrow(/conflicting ChatGPT conversation identities/i);
  });

  test("does not match a conversation id from a noncanonical stored URL", () => {
    expect(() =>
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-untrusted-url", [
        session("untrusted-url", {
          config: {
            url: "https://example.invalid/c/thread-untrusted-url",
            ...config("127.0.0.1", 9223, "browser-a"),
          },
        }),
      ]),
    ).toThrow(/no stored browser session matches/i);
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
          runtime: {
            chromeBrowserWSEndpoint: browserWSEndpoint,
            chatGptAccountDigest: accountDigest,
          },
        }),
      ]),
    ).toEqual({
      host: "127.0.0.1",
      port: 9229,
      browserId: "browser-a",
      browserWSEndpoint,
      accountDigest,
    });
  });

  test("resolves legacy metadata without options from browser config and runtime affinity", () => {
    const browserWSEndpoint = ws("browser-legacy", "127.0.0.1", 9230);
    const legacy = {
      id: "legacy",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      browser: {
        config: {
          url: "https://chatgpt.com/c/thread-legacy-options",
          remoteChrome: { host: "127.0.0.1", port: 9230 },
        },
        runtime: {
          chromeBrowserWSEndpoint: browserWSEndpoint,
          chatGptAccountDigest: accountDigest,
        },
      },
    } as SessionMetadata;

    expect(
      resolveChatGptExportRemoteChromeForSession(
        "https://chatgpt.com/c/thread-legacy-options",
        "legacy-directory-key",
        legacy,
      ),
    ).toEqual({
      host: "127.0.0.1",
      port: 9230,
      browserId: "browser-legacy",
      browserWSEndpoint,
      accountDigest,
    });
  });

  test("uses the named originating session when one conversation has multiple affinities", () => {
    const targetUrl = "https://chatgpt.com/c/thread-session-bound";
    const primary = session("primary", {
      harvest: { conversationId: "thread-session-bound" },
      config: config("127.0.0.1", 9223, "browser-primary"),
    });
    const backup = session("backup", {
      harvest: { conversationId: "thread-session-bound" },
      config: config("127.0.0.1", 9333, "browser-backup"),
    });

    expect(() => resolveChatGptExportRemoteChrome(targetUrl, [primary, backup])).toThrow(
      /conflicting stored remote Chrome browser affinities/i,
    );
    expect(resolveChatGptExportRemoteChromeForSession(targetUrl, "backup", backup)).toEqual(
      affinity("127.0.0.1", 9333, "browser-backup"),
    );
  });

  test("uses the named session despite incomplete matching legacy metadata", () => {
    const targetUrl = "https://chatgpt.com/c/thread-legacy-match";
    const legacy = session("legacy", {
      harvest: { conversationId: "thread-legacy-match" },
    });
    const originating = session("originating", {
      harvest: { conversationId: "thread-legacy-match" },
      config: config("127.0.0.1", 9444, "browser-originating"),
    });

    expect(() => resolveChatGptExportRemoteChrome(targetUrl, [legacy, originating])).toThrow(
      /no stored remote Chrome endpoint/i,
    );
    expect(
      resolveChatGptExportRemoteChromeForSession(targetUrl, "originating", originating),
    ).toEqual(affinity("127.0.0.1", 9444, "browser-originating"));
  });

  test("rejects missing or mismatched named sessions", () => {
    const targetUrl = "https://chatgpt.com/c/thread-exact";
    expect(() => resolveChatGptExportRemoteChromeForSession(targetUrl, "missing", null)).toThrow(
      /requested stored Oracle session was not found/i,
    );
    expect(() =>
      resolveChatGptExportRemoteChromeForSession(
        targetUrl,
        "other",
        session("other", { harvest: { conversationId: "different-thread" } }),
      ),
    ).toThrow(/requested stored Oracle session does not match the ChatGPT conversation/i);
  });
  test("fails closed with a supported recovery hint when no session matches", () => {
    const resolve = () =>
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-3", [
        session("other", {
          config: {
            url: "https://chatgpt.com/c/other-thread",
            ...config("127.0.0.1", 9225, "browser-a"),
          },
        }),
      ]);

    expect(resolve).toThrow(/no stored browser session matches/i);
    expect(resolve).toThrow(/--session-id.*account-bound wrapper/i);
    try {
      resolve();
    } catch (error) {
      expect((error as Error).message).not.toContain("Pass --remote-chrome explicitly");
    }
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

  test("rejects incomplete session-derived affinity outside the wrapper", () => {
    expect(() =>
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-host-only", [
        session("host-only", {
          harvest: { conversationId: "thread-host-only" },
          config: { remoteChrome: { host: "127.0.0.1", port: 9223 } },
        }),
      ]),
    ).toThrow(/browser and account identity is unavailable/i);
  });

  test("rejects incomplete wrapper-routed session affinity", () => {
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
      ).toThrow(/browser and account identity is unavailable/i);
    } finally {
      if (previous === undefined) delete process.env.ORACLE_WRAPPER_REMOTE_ONLY;
      else process.env.ORACLE_WRAPPER_REMOTE_ONLY = previous;
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
  test("rejects a runtime browser receipt outside its configured authority", () => {
    expect(() =>
      resolveChatGptExportRemoteChrome("https://chatgpt.com/c/thread-authority-conflict", [
        session("authority-conflict", {
          harvest: { conversationId: "thread-authority-conflict" },
          config: config("127.0.0.1", 9223, "browser-a"),
          runtime: {
            chromeBrowserWSEndpoint: ws("browser-a", "127.0.0.1", 9224),
            chatGptAccountDigest: accountDigest,
          },
        }),
      ]),
    ).toThrow(/authority/i);
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
  test("rejects different account bindings on the same browser generation", () => {
    const targetUrl = "https://chatgpt.com/c/thread-account-switch";
    expect(() =>
      resolveChatGptExportRemoteChrome(targetUrl, [
        session("account-a", {
          harvest: { conversationId: "thread-account-switch" },
          config: config("127.0.0.1", 9223, "browser-a"),
        }),
        session("account-b", {
          harvest: { conversationId: "thread-account-switch" },
          config: {
            ...config("127.0.0.1", 9223, "browser-a"),
            remoteChromeAccountDigest: "b".repeat(64),
          },
        }),
      ]),
    ).toThrow(/conflicting stored remote Chrome browser affinities/i);
  });
});
