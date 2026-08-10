import { describe, expect, test } from "vitest";
import {
  recoverBrowserMetadataFromHarvestForTest,
  resolveSessionTabRefForTest,
} from "../../src/cli/browserTabs.js";
import type { ChatGptTabSummary } from "../../src/browser/liveTabs.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

describe("browser tab CLI helpers", () => {
  test("prefers stable conversation URLs over stale Chrome target ids", () => {
    const meta = {
      id: "session-1",
      createdAt: "2026-05-05T00:00:00.000Z",
      status: "completed",
      options: {},
      mode: "browser",
      browser: {
        runtime: {
          chromeTargetId: "stale-target",
          tabUrl: "https://chatgpt.com/c/runtime-conversation",
          conversationId: "runtime-conversation",
        },
      },
    } as SessionMetadata;

    expect(resolveSessionTabRefForTest(meta)).toBe("https://chatgpt.com/c/runtime-conversation");
  });

  test("uses the configured conversation URL when runtime metadata is missing", () => {
    const meta = {
      id: "session-config-only",
      createdAt: "2026-08-07T00:00:00.000Z",
      status: "error",
      options: {},
      mode: "browser",
      browser: {
        config: {
          url: "https://chatgpt.com/g/project/c/configured-conversation",
        },
      },
    } as SessionMetadata;

    expect(resolveSessionTabRefForTest(meta)).toBe(
      "https://chatgpt.com/g/project/c/configured-conversation",
    );
  });

  test("refuses the current shared tab when a named session has no browser identity", () => {
    const meta = {
      id: "unbound-session",
      createdAt: "2026-08-10T00:00:00.000Z",
      status: "pending",
      options: {},
      mode: "browser",
      browser: {
        config: {
          url: "https://chatgpt.com/g/project",
        },
      },
    } as SessionMetadata;

    expect(() => resolveSessionTabRefForTest(meta)).toThrow(/Refusing to use the shared browser/);
  });

  const harvested = (overrides: Partial<ChatGptTabSummary> = {}): ChatGptTabSummary => ({
    targetId: "ABCDEF12",
    title: "Oracle review",
    url: "https://chatgpt.com/g/g-p-1234abcd-oracle/c/conversation-123",
    currentModelLabel: "Pro",
    stopExists: false,
    sendExists: false,
    promptReady: true,
    loginButtonExists: false,
    authenticated: true,
    assistantCount: 2,
    lastAssistantText: '{"outcome":"clean_for_closeout","clean":true,"summary":"ready "}',
    lastAssistantSnippet: "clean",
    lastUserText: "Review this exact candidate and return JSON only.",
    lastUserSnippet: "Review this exact candidate and return JSON only.",
    focused: false,
    visibilityState: "visible",
    conversationId: "conversation-123",
    fingerprint: "fingerprint",
    state: "completed",
    lastAssistantMarkdown: '{"outcome":"clean_for_closeout","clean":true,"summary":"ready "}',
    ...overrides,
  });

  const staleSession = (): SessionMetadata =>
    ({
      id: "session-1",
      createdAt: "2026-07-22T00:00:00.000Z",
      status: "completed",
      promptPreview: "Review this exact candidate",
      options: { writeOutputPath: "/tmp/oracle-output.md" },
      mode: "browser",
      browser: {
        config: { url: "https://chatgpt.com/g/g-p-1234abcd/project" },
        runtime: {
          chromeTargetId: "OLD00000",
          tabUrl: "https://chatgpt.com/g/g-p-1234abcd/project",
        },
        archive: {
          mode: "never",
          attempted: false,
          archived: false,
          conversationUrl: "https://chatgpt.com/g/g-p-1234abcd/project",
        },
      },
    }) as SessionMetadata;

  test("repairs stale project-root identity from a matching completed harvest", () => {
    const meta = staleSession();
    meta.promptPreview = "# Review this exact candidate";
    const browser = recoverBrowserMetadataFromHarvestForTest(
      meta,
      harvested({
        lastUserText:
          "attachments-bundle(31).txtDocument# Review this exact candidate and return JSON only.",
        lastUserSnippet:
          "attachments-bundle(31).txtDocument# Review this exact candidate and return JSON only.",
      }),
      '{"outcome":"clean_for_closeout","clean":true,"summary":"ready \n\nattachments-bundle\n\n"}',
    );

    expect(browser.runtime).toMatchObject({
      chromeTargetId: "ABCDEF12",
      tabUrl: "https://chatgpt.com/g/g-p-1234abcd-oracle/c/conversation-123",
      conversationId: "conversation-123",
    });
    expect(browser.archive?.conversationUrl).toBe(
      "https://chatgpt.com/g/g-p-1234abcd-oracle/c/conversation-123",
    );
    expect(browser.harvest).toMatchObject({
      outputMatched: true,
      promptMatched: true,
      runtimeRepaired: true,
    });
  });

  test("does not repair identity when harvested output differs", () => {
    const browser = recoverBrowserMetadataFromHarvestForTest(
      staleSession(),
      harvested(),
      '{"outcome":"implementation_repair_required","clean":false}',
    );

    expect(browser.runtime?.tabUrl).toBe("https://chatgpt.com/g/g-p-1234abcd/project");
    expect(browser.harvest?.runtimeRepaired).toBe(false);
    expect(browser.harvest?.outputMatched).toBe(false);
  });

  test("does not overwrite a different recorded conversation", () => {
    const meta = staleSession();
    meta.browser!.runtime = {
      chromeTargetId: "OLD00000",
      tabUrl: "https://chatgpt.com/g/g-p-1234abcd/c/different-conversation",
      conversationId: "different-conversation",
    };
    const browser = recoverBrowserMetadataFromHarvestForTest(
      meta,
      harvested(),
      '{"outcome":"clean_for_closeout","clean":true,"summary":"ready "}',
    );

    expect(browser.runtime?.conversationId).toBe("different-conversation");
    expect(browser.harvest?.runtimeRepaired).toBe(false);
  });
});
