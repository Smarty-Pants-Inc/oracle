import { describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";
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

function committedRuntime(
  conversationId: string,
  runtime: Omit<BrowserRuntimeMetadata, "conversationId" | "promptEpoch"> = {},
): BrowserRuntimeMetadata {
  return {
    ...runtime,
    conversationId,
    promptEpoch: {
      status: "committed",
      epochId: `epoch-${conversationId}`,
      promptSha256: "a".repeat(64),
      baselineTurns: 0,
      followUpOrdinal: 0,
      remainingFollowUps: 0,
      verifiedUserTurnIndex: 0,
      verifiedUserTurnId: "turn-0",
      verifiedUserMessageId: "message-0",
      conversationId,
    },
  };
}

describe("browser follow-up resolution", () => {
  test("derives a resume URL from conversationId", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: { url: "https://chatgpt.com/" },
        runtime: committedRuntime("abc-123"),
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBe("https://chatgpt.com/c/abc-123");
  });

  test("derives a resume URL from tabUrl", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        runtime: committedRuntime("live-thread", {
          tabUrl: "https://chatgpt.com/c/live-thread",
        }),
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
        runtime: committedRuntime("resume-me"),
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
      /structurally valid committed prompt epoch.*oracle status/s,
    );
  });

  test("uses a harvested URL only when it matches the committed epoch", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        harvest: { url: "https://chatgpt.com/c/harvested" },
        runtime: committedRuntime("harvested"),
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBe("https://chatgpt.com/c/harvested");
  });

  test("rejects epoch-less browser locator fields", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: { runtime: { conversationId: "legacy-only" } },
    };
    expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();
  });

  test.each([
    {
      harvestUrl: "https://chatgpt.com/c/committed-id",
      runtimeUrl: "https://chatgpt.com/c/wrong-runtime",
    },
    {
      harvestUrl: "https://chatgpt.com/c/wrong-harvest",
      runtimeUrl: "https://chatgpt.com/c/committed-id",
    },
  ])(
    "rejects conflicting harvest/runtime URLs for a committed prompt epoch",
    ({ harvestUrl, runtimeUrl }) => {
      const metadata: SessionMetadata = {
        ...baseMetadata,
        mode: "browser",
        browser: {
          harvest: { url: harvestUrl },
          runtime: {
            tabUrl: runtimeUrl,
            promptEpoch: {
              status: "committed",
              epochId: "epoch-1",
              promptSha256: "a".repeat(64),
              baselineTurns: 0,
              followUpOrdinal: 0,
              remainingFollowUps: 0,
              verifiedUserTurnIndex: 0,
              verifiedUserTurnId: "turn-0",
              verifiedUserMessageId: "message-0",
              conversationId: "committed-id",
            },
          },
        },
      };

      expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();
    },
  );

  test("uses the committed epoch id as the only URL fallback authority", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: { url: "https://chatgpt.com/" },
        runtime: {
          conversationId: "committed-id",
          promptEpoch: {
            status: "committed",
            epochId: "epoch-1",
            promptSha256: "a".repeat(64),
            baselineTurns: 0,
            followUpOrdinal: 0,
            remainingFollowUps: 0,
            verifiedUserTurnIndex: 0,
            verifiedUserTurnId: "turn-0",
            verifiedUserMessageId: "message-0",
            conversationId: "committed-id",
          },
        },
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBe(
      "https://chatgpt.com/c/committed-id",
    );
    expect(
      resolveBrowserResumeConversationUrl({
        ...metadata,
        browser: {
          ...metadata.browser!,
          runtime: { ...metadata.browser!.runtime!, conversationId: "wrong-runtime-id" },
        },
      }),
    ).toBeNull();
  });

  test("rejects URL fallback while a prompt epoch is pending", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        runtime: {
          conversationId: "pending-id",
          promptEpoch: {
            status: "pending",
            epochId: "epoch-pending",
            promptSha256: "a".repeat(64),
            baselineTurns: 0,
            followUpOrdinal: 0,
            remainingFollowUps: 0,
          },
        },
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();
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
      /structurally valid committed prompt epoch/s,
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
      /structurally valid committed prompt epoch/s,
    );
  });

  test("uses the canonical ChatGPT URL when the committed epoch is exact", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: { url: "https://evil.example.com/" },
        runtime: committedRuntime("abc-123"),
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBe("https://chatgpt.com/c/abc-123");
  });

  test("rejects insecure or non-default-port conversation URLs", () => {
    for (const tabUrl of [
      "http://chatgpt.com/c/insecure",
      "https://chatgpt.com:444/c/wrong-port",
    ]) {
      const conversationId = tabUrl.includes("insecure") ? "insecure" : "wrong-port";
      const metadata: SessionMetadata = {
        ...baseMetadata,
        mode: "browser",
        browser: { runtime: committedRuntime(conversationId, { tabUrl }) },
      };
      expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();
    }
  });
});
