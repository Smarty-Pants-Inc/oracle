import { afterEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";
import {
  resolveBrowserFollowupReference,
  resolveBrowserResumeConversationUrl,
} from "../../src/cli/followup.js";

const baseMetadata: SessionMetadata = {
  id: "session-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "completed",
  options: {},
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("browser follow-up resolution", () => {
  test("derives a resume URL from conversationId", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: { url: "https://chatgpt.com/" },
        runtime: { conversationId: "abc-123" },
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBe("https://chatgpt.com/c/abc-123");
  });

  test("derives a resume URL from tabUrl", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        runtime: { tabUrl: "https://chatgpt.com/c/live-thread" },
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBe("https://chatgpt.com/c/live-thread");
  });

  test("resolves stored browser sessions to a browser resume path", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "browser-slug",
      mode: "browser",
      model: "gpt-5.5-pro",
      browser: {
        config: {
          manualLogin: true,
          manualLoginProfileDir: "/tmp/oracle-profile",
          browserTabRef: "stale-tab",
          researchMode: "deep",
          archiveConversations: "auto",
        },
        runtime: { conversationId: "resume-me" },
      },
    };
    const store = { readSession: vi.fn(async () => metadata) };

    await expect(resolveBrowserFollowupReference("browser-slug", store)).resolves.toEqual({
      sessionId: "browser-slug",
      resumeConversationUrl: "https://chatgpt.com/c/resume-me",
      model: "gpt-5.5-pro",
      browserConfig: {
        manualLogin: true,
        manualLoginProfileDir: "/tmp/oracle-profile",
        browserTabRef: null,
        researchMode: "off",
        archiveConversations: "never",
        resumeConversationUrl: "https://chatgpt.com/c/resume-me",
      },
    });
  });

  test("preserves the originating remote browser affinity", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: {
          remoteChrome: { host: "127.0.0.1", port: 9223 },
          remoteChromeBrowserId: "browser-a",
          remoteChromeBrowserWSEndpoint: browserWSEndpoint,
          remoteChromeAccountDigest: accountDigest,
        },
        runtime: {
          conversationId: "remote-thread",
          chromeBrowserWSEndpoint: browserWSEndpoint,
          chatGptAccountDigest: accountDigest,
        },
      },
    };

    await expect(
      resolveBrowserFollowupReference("session-1", {
        readSession: vi.fn(async () => metadata),
      }),
    ).resolves.toMatchObject({
      browserConfig: {
        remoteChromeBrowserId: "browser-a",
        remoteChromeBrowserWSEndpoint: browserWSEndpoint,
        remoteChromeAccountDigest: accountDigest,
      },
    });
  });

  test.each([
    ["user", 9222, "browser-user"],
    ["agent", 9223, "browser-agent"],
  ] as const)(
    "inherits %s request origin and endpoint for wrapper-routed browser follow-ups",
    async (requestOrigin, port, browserId) => {
      vi.stubEnv("ORACLE_WRAPPER_REMOTE_ONLY", "1");
      const browserWSEndpoint = `ws://127.0.0.1:${port}/devtools/browser/${browserId}`;
      const accountDigest = "a".repeat(64);
      const metadata: SessionMetadata = {
        ...baseMetadata,
        mode: "browser",
        requestOrigin,
        options: { requestOrigin },
        browser: {
          config: {
            remoteChrome: { host: "127.0.0.1", port },
            remoteChromeBrowserId: browserId,
            remoteChromeBrowserWSEndpoint: browserWSEndpoint,
            remoteChromeAccountDigest: accountDigest,
          },
          runtime: {
            conversationId: `${requestOrigin}-thread`,
            chromeBrowserWSEndpoint: browserWSEndpoint,
            chatGptAccountDigest: accountDigest,
          },
        },
      };

      await expect(
        resolveBrowserFollowupReference("session-1", {
          readSession: vi.fn(async () => metadata),
        }),
      ).resolves.toMatchObject({
        requestOrigin,
        browserConfig: {
          remoteChrome: { host: "127.0.0.1", port },
          remoteChromeBrowserId: browserId,
        },
      });
    },
  );
  test.each([
    ["user", "paul@smartypants.ai", "Paul Bettner"],
    ["agent", "dev1@smartypants.ai", "Smarty Dev"],
  ] as const)(
    "preserves the exact %s main-Chrome account, workspace, tab, and thread",
    async (requestOrigin, email, workspaceName) => {
      vi.stubEnv("ORACLE_WRAPPER_REMOTE_ONLY", "1");
      const metadata: SessionMetadata = {
        ...baseMetadata,
        mode: "browser",
        requestOrigin,
        options: {
          requestOrigin,
          browserConfig: {
            browserTransport: "obu",
            obuSessionId: `oracle-${requestOrigin}`,
            obuTabId: requestOrigin === "user" ? 7 : 8,
            chatGptAccountEmail: email,
            chatGptWorkspaceName: workspaceName,
            chatGptAccountDigest: "a".repeat(64),
            chatGptWorkspaceDigest: "b".repeat(64),
          },
        },
        browser: {
          runtime: {
            browserTransport: "obu",
            obuSessionId: `oracle-${requestOrigin}`,
            obuTabId: requestOrigin === "user" ? 7 : 8,
            chatGptAccountEmail: email,
            chatGptWorkspaceName: workspaceName,
            chatGptAccountDigest: "a".repeat(64),
            chatGptWorkspaceDigest: "b".repeat(64),
            conversationId: `${requestOrigin}-thread`,
            promptTurnIndex: 0,
            promptTurnId: `user-${requestOrigin}`,
            promptMessageId: `user-message-${requestOrigin}`,
            assistantTurnIndex: 1,
            assistantTurnId: `assistant-${requestOrigin}`,
            assistantMessageId: `assistant-message-${requestOrigin}`,
          },
        },
      };

      await expect(
        resolveBrowserFollowupReference("session-1", {
          readSession: vi.fn(async () => metadata),
        }),
      ).resolves.toMatchObject({
        requestOrigin,
        resumeConversationUrl: `https://chatgpt.com/c/${requestOrigin}-thread`,
        browserConfig: {
          browserTransport: "obu",
          obuSessionId: `oracle-${requestOrigin}`,
          chatGptAccountEmail: email,
          chatGptWorkspaceName: workspaceName,
          browserTabRef: null,
          resumeTurnBinding: {
            promptTurnIndex: 0,
            promptTurnId: `user-${requestOrigin}`,
            promptMessageId: `user-message-${requestOrigin}`,
            assistantTurnIndex: 1,
            assistantTurnId: `assistant-${requestOrigin}`,
            assistantMessageId: `assistant-message-${requestOrigin}`,
          },
        },
      });
    },
  );
  test("rejects stored main-Chrome metadata whose origin names the wrong account", async () => {
    vi.stubEnv("ORACLE_WRAPPER_REMOTE_ONLY", "1");
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      requestOrigin: "agent",
      options: { requestOrigin: "agent" },
      browser: {
        config: {
          browserTransport: "obu",
          chatGptAccountEmail: "paul@smartypants.ai",
          chatGptWorkspaceName: "Paul Bettner",
          chatGptAccountDigest: "a".repeat(64),
          chatGptWorkspaceDigest: "b".repeat(64),
        },
        runtime: {
          browserTransport: "obu",
          obuSessionId: "oracle-agent",
          obuTabId: 8,
          chatGptAccountEmail: "paul@smartypants.ai",
          chatGptWorkspaceName: "Paul Bettner",
          chatGptAccountDigest: "a".repeat(64),
          chatGptWorkspaceDigest: "b".repeat(64),
          conversationId: "agent-thread",
          promptTurnIndex: 0,
          promptTurnId: "user-agent",
          assistantTurnIndex: 1,
          assistantTurnId: "assistant-agent",
        },
      },
    };
    await expect(
      resolveBrowserFollowupReference("session-1", {
        readSession: vi.fn(async () => metadata),
      }),
    ).rejects.toThrow(/bound to dev1@smartypants\.ai/i);
  });

  test("rejects a main-Chrome follow-up without exact prompt and assistant affinity", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      options: {
        browserConfig: {
          browserTransport: "obu",
          obuSessionId: "oracle-session",
          obuTabId: 7,
          chatGptAccountEmail: "paul@smartypants.ai",
          chatGptWorkspaceName: "Paul Bettner",
          chatGptAccountDigest: "a".repeat(64),
          chatGptWorkspaceDigest: "b".repeat(64),
        },
      },
      browser: {
        runtime: {
          browserTransport: "obu",
          obuSessionId: "oracle-session",
          obuTabId: 7,
          chatGptAccountEmail: "paul@smartypants.ai",
          chatGptWorkspaceName: "Paul Bettner",
          chatGptAccountDigest: "a".repeat(64),
          chatGptWorkspaceDigest: "b".repeat(64),
          conversationId: "thread-without-assistant-binding",
          promptTurnIndex: 0,
          promptMessageId: "prompt-message",
        },
      },
    };

    await expect(
      resolveBrowserFollowupReference("session-1", {
        readSession: vi.fn(async () => metadata),
      }),
    ).rejects.toThrow(/no exact stored prompt\/assistant branch/i);
  });

  test("rejects conflicting duplicated main-Chrome affinity", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      options: {
        browserConfig: {
          browserTransport: "obu",
          obuSessionId: "oracle-session",
          obuTabId: 7,
          chatGptAccountEmail: "paul@smartypants.ai",
          chatGptWorkspaceName: "Paul Bettner",
          chatGptAccountDigest: "a".repeat(64),
          chatGptWorkspaceDigest: "b".repeat(64),
        },
      },
      browser: {
        runtime: {
          browserTransport: "obu",
          obuSessionId: "oracle-session",
          obuTabId: 8,
          chatGptAccountEmail: "paul@smartypants.ai",
          chatGptWorkspaceName: "Paul Bettner",
          chatGptAccountDigest: "a".repeat(64),
          chatGptWorkspaceDigest: "b".repeat(64),
          conversationId: "thread-conflict",
        },
      },
    };
    await expect(
      resolveBrowserFollowupReference("session-1", { readSession: vi.fn(async () => metadata) }),
    ).rejects.toThrow(/tab identity is conflicting/i);
  });

  test("rejects conflicting duplicated main-Chrome conversation affinity", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      options: {
        browserConfig: {
          browserTransport: "obu",
          obuSessionId: "oracle-session",
          obuTabId: 7,
          chatGptAccountEmail: "paul@smartypants.ai",
          chatGptWorkspaceName: "Paul Bettner",
          chatGptAccountDigest: "a".repeat(64),
          chatGptWorkspaceDigest: "b".repeat(64),
        },
      },
      browser: {
        harvest: {
          conversationId: "thread-two",
          url: "https://chatgpt.com/c/thread-two",
        },
        runtime: {
          browserTransport: "obu",
          obuSessionId: "oracle-session",
          obuTabId: 7,
          chatGptAccountEmail: "paul@smartypants.ai",
          chatGptWorkspaceName: "Paul Bettner",
          chatGptAccountDigest: "a".repeat(64),
          chatGptWorkspaceDigest: "b".repeat(64),
          tabUrl: "https://chatgpt.com/c/thread-one",
          conversationId: "thread-one",
        },
      },
    };

    await expect(
      resolveBrowserFollowupReference("session-1", { readSession: vi.fn(async () => metadata) }),
    ).rejects.toThrow(/conversation affinity is conflicting/i);
  });

  test("fails closed for legacy wrapper sessions without request origin", async () => {
    vi.stubEnv("ORACLE_WRAPPER_REMOTE_ONLY", "1");
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: {
          remoteChrome: { host: "127.0.0.1", port: 9223 },
          remoteChromeBrowserId: "browser-a",
          remoteChromeBrowserWSEndpoint: browserWSEndpoint,
          remoteChromeAccountDigest: accountDigest,
        },
        runtime: {
          conversationId: "legacy-thread",
          chromeBrowserWSEndpoint: browserWSEndpoint,
          chatGptAccountDigest: accountDigest,
        },
      },
    };

    await expect(
      resolveBrowserFollowupReference("session-1", { readSession: vi.fn(async () => metadata) }),
    ).rejects.toThrow(/no verified request origin/i);
  });

  test("rejects conflicting stored request origin metadata", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      requestOrigin: "user",
      options: { requestOrigin: "agent" },
      browser: {
        config: { url: "https://chatgpt.com/" },
        runtime: { conversationId: "conflicting-origin" },
      },
    };

    await expect(
      resolveBrowserFollowupReference("session-1", { readSession: vi.fn(async () => metadata) }),
    ).rejects.toThrow(/conflicting stored request origin/i);
  });

  test("carries the runtime account digest with a derived browser identity", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: { remoteChrome: { host: "127.0.0.1", port: 9223 } },
        runtime: {
          conversationId: "legacy-thread",
          chromeBrowserWSEndpoint: browserWSEndpoint,
          chatGptAccountDigest: accountDigest,
        },
      },
    };
    await expect(
      resolveBrowserFollowupReference("session-1", { readSession: vi.fn(async () => metadata) }),
    ).resolves.toMatchObject({
      browserConfig: {
        remoteChromeBrowserId: "browser-a",
        remoteChromeBrowserWSEndpoint: browserWSEndpoint,
        remoteChromeAccountDigest: accountDigest,
      },
    });
  });

  test("rejects incomplete remote follow-up affinity outside the wrapper", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: { remoteChrome: { host: "127.0.0.1", port: 9223 } },
        runtime: { conversationId: "host-only-thread" },
      },
    };
    await expect(
      resolveBrowserFollowupReference("session-1", { readSession: vi.fn(async () => metadata) }),
    ).rejects.toThrow(/browser and account identity/i);
  });

  test("rejects runtime-only remote affinity without its stored endpoint", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: { url: "https://chatgpt.com/" },
        runtime: {
          conversationId: "runtime-only-thread",
          chromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
          chatGptAccountDigest: "a".repeat(64),
        },
      },
    };
    await expect(
      resolveBrowserFollowupReference("session-1", { readSession: vi.fn(async () => metadata) }),
    ).rejects.toThrow(/browser and account identity/i);
  });

  test("fails closed for wrapper-routed sessions with only host and port", async () => {
    const previous = process.env.ORACLE_WRAPPER_REMOTE_ONLY;
    process.env.ORACLE_WRAPPER_REMOTE_ONLY = "1";
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: { remoteChrome: { host: "127.0.0.1", port: 9223 } },
        runtime: { conversationId: "host-only-thread" },
      },
    };

    try {
      await expect(
        resolveBrowserFollowupReference("session-1", {
          readSession: vi.fn(async () => metadata),
        }),
      ).rejects.toThrow(/browser and account identity/i);
    } finally {
      if (previous === undefined) {
        delete process.env.ORACLE_WRAPPER_REMOTE_ONLY;
      } else {
        process.env.ORACLE_WRAPPER_REMOTE_ONLY = previous;
      }
    }
  });

  test("fails closed when duplicated browser endpoint metadata conflicts", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      options: {
        browserConfig: { remoteChrome: { host: "127.0.0.1", port: 9222 } },
      },
      browser: {
        config: { remoteChrome: { host: "127.0.0.1", port: 9223 } },
        runtime: { conversationId: "conflicting-endpoint" },
      },
    };

    await expect(
      resolveBrowserFollowupReference("session-1", { readSession: vi.fn(async () => metadata) }),
    ).rejects.toThrow(/conflicting stored Chrome endpoint metadata/i);
  });

  test("fails closed when duplicated browser identity metadata conflicts", async () => {
    const endpoint = { host: "127.0.0.1", port: 9223 };
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      options: {
        browserConfig: {
          remoteChrome: endpoint,
          remoteChromeBrowserId: "browser-a",
          remoteChromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
        },
      },
      browser: {
        config: {
          remoteChrome: endpoint,
          remoteChromeBrowserId: "browser-b",
          remoteChromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-b",
        },
        runtime: { conversationId: "conflicting-browser" },
      },
    };

    await expect(
      resolveBrowserFollowupReference("session-1", { readSession: vi.fn(async () => metadata) }),
    ).rejects.toThrow(/conflicting stored browser identity metadata/i);
  });

  test("fails closed when duplicated account identity metadata conflicts", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      options: {
        browserConfig: {
          remoteChrome: { host: "127.0.0.1", port: 9223 },
          remoteChromeBrowserId: "browser-a",
          remoteChromeBrowserWSEndpoint: browserWSEndpoint,
          remoteChromeAccountDigest: "a".repeat(64),
        },
      },
      browser: {
        config: {
          remoteChrome: { host: "127.0.0.1", port: 9223 },
          remoteChromeBrowserId: "browser-a",
          remoteChromeBrowserWSEndpoint: browserWSEndpoint,
          remoteChromeAccountDigest: "b".repeat(64),
        },
        runtime: { conversationId: "conflicting-account" },
      },
    };

    await expect(
      resolveBrowserFollowupReference("session-1", { readSession: vi.fn(async () => metadata) }),
    ).rejects.toThrow(/conflicting stored account identity metadata/i);
  });

  test("fails closed when runtime and configured endpoints conflict", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: { remoteChrome: { host: "127.0.0.1", port: 9223 } },
        runtime: {
          conversationId: "conflicting-runtime-endpoint",
          chromeHost: "127.0.0.1",
          chromePort: 9224,
        },
      },
    };

    await expect(
      resolveBrowserFollowupReference("session-1", { readSession: vi.fn(async () => metadata) }),
    ).rejects.toThrow(/conflicting stored Chrome endpoint metadata/i);
  });

  test("fails closed when configured and runtime browser identities conflict", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: {
          remoteChrome: { host: "127.0.0.1", port: 9223 },
          remoteChromeBrowserId: "browser-a",
          remoteChromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
        },
        runtime: {
          conversationId: "conflicting-thread",
          chromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-b",
        },
      },
    };

    await expect(
      resolveBrowserFollowupReference("session-1", {
        readSession: vi.fn(async () => metadata),
      }),
    ).rejects.toThrow(/conflicting stored browser identity metadata/i);
  });

  test("leaves stored API sessions on the existing API follow-up path", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "api-slug",
      mode: "api",
      response: { id: "resp_parent" },
    };
    const store = { readSession: vi.fn(async () => metadata) };

    await expect(resolveBrowserFollowupReference("api-slug", store)).resolves.toBeNull();
  });

  test("errors clearly when a browser session has no conversation URL", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "missing-url",
      mode: "browser",
      browser: { runtime: { chromePort: 9222 } },
    };
    const store = { readSession: vi.fn(async () => metadata) };

    await expect(resolveBrowserFollowupReference("missing-url", store)).rejects.toThrow(
      /does not contain a ChatGPT conversation URL.*oracle status/s,
    );
  });

  test("prefers the harvested URL over a stale runtime tab URL", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        harvest: { url: "https://chatgpt.com/c/harvested" },
        runtime: { tabUrl: "https://chatgpt.com/c/stale-runtime" },
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBe("https://chatgpt.com/c/harvested");
  });

  test("rejects an external resume URL stored in metadata", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "external-url",
      mode: "browser",
      browser: { runtime: { tabUrl: "https://evil.example.com/c/pwned" } },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();

    const store = { readSession: vi.fn(async () => metadata) };
    await expect(resolveBrowserFollowupReference("external-url", store)).rejects.toThrow(
      /does not contain a ChatGPT conversation URL/s,
    );
  });

  test("rejects a project-shell URL that has no conversation id", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "project-shell",
      mode: "browser",
      browser: {
        config: { url: "https://chatgpt.com/g/g-p-abc123/project" },
        runtime: { tabUrl: "https://chatgpt.com/g/g-p-abc123/project" },
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();

    const store = { readSession: vi.fn(async () => metadata) };
    await expect(resolveBrowserFollowupReference("project-shell", store)).rejects.toThrow(
      /does not contain a ChatGPT conversation URL/s,
    );
  });

  test("rejects a conversationId fallback when the base URL is not ChatGPT", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: { url: "https://evil.example.com/" },
        runtime: { conversationId: "abc-123" },
      },
    };

    // conversationId would rebuild against the stored base; the gate must reject a non-ChatGPT host.
    expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();
  });

  test("rejects insecure or non-default-port conversation URLs", () => {
    for (const tabUrl of [
      "http://chatgpt.com/c/insecure",
      "https://chatgpt.com:444/c/wrong-port",
    ]) {
      const metadata: SessionMetadata = {
        ...baseMetadata,
        mode: "browser",
        browser: { runtime: { tabUrl } },
      };
      expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();
    }
  });
});
