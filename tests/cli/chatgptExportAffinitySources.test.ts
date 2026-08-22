import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";
import {
  handleChatGptExportCommand,
  type ChatGptExportCliOptions,
} from "../../src/cli/chatgptExport.js";
import { CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV } from "../../src/cli/chatgptRemoteAffinity.js";

const mocks = vi.hoisted(() => ({
  captureDirect: vi.fn(),
  captureObu: vi.fn(),
  readSession: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock("../../src/browser/chatgptExport.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    captureApprovedChatGptConversationBackend: mocks.captureDirect,
    captureApprovedChatGptConversationBackendViaObu: mocks.captureObu,
  };
});

vi.mock("../../src/sessionStore.js", () => ({
  sessionStore: {
    readSession: mocks.readSession,
    listSessions: mocks.listSessions,
  },
}));

const targetUrl = "https://chatgpt.com/c/thread-affinity";
const accountDigest = "a".repeat(64);

const conflictCases: Array<[string, ChatGptExportCliOptions, RegExp]> = [
  [
    "session and remote Chrome",
    { sessionId: "session-a", remoteChrome: "127.0.0.1:9223" },
    /--session-id cannot be combined with --remote-chrome/i,
  ],
  [
    "session and explicit browser id",
    { sessionId: "session-a", remoteChromeBrowserId: "browser-a" },
    /--session-id cannot be combined.*browser\/account affinity/i,
  ],
  [
    "session and explicit browser WebSocket",
    {
      sessionId: "session-a",
      remoteChromeBrowserWs: "ws://127.0.0.1:9223/devtools/browser/browser-a",
    },
    /--session-id cannot be combined.*browser\/account affinity/i,
  ],
  [
    "session and explicit account digest",
    { sessionId: "session-a", remoteChromeAccountDigest: accountDigest },
    /--session-id cannot be combined.*browser\/account affinity/i,
  ],
  [
    "session and explicit expected account",
    { sessionId: "session-a", expectedEmail: "owner@example.test" },
    /--session-id cannot be combined.*browser\/account affinity/i,
  ],
  [
    "OBU and Oracle session",
    { obuSessionId: "obu-a", obuTabId: "tab-a", sessionId: "session-a" },
    /OBU affinity.*cannot be combined with --session-id/i,
  ],
  [
    "OBU and remote Chrome",
    { obuSessionId: "obu-a", obuTabId: "tab-a", remoteChrome: "127.0.0.1:9223" },
    /OBU affinity.*cannot be combined.*--remote-chrome/i,
  ],
  [
    "OBU and explicit browser affinity",
    { obuSessionId: "obu-a", obuTabId: "tab-a", remoteChromeAccountDigest: accountDigest },
    /OBU affinity.*cannot be combined.*browser\/account affinity/i,
  ],
  [
    "OBU and CDP browser tab",
    { obuSessionId: "obu-a", obuTabId: "tab-a", browserTab: "current" },
    /--browser-tab cannot be combined with OBU affinity/i,
  ],
];

describe("ChatGPT export affinity source conflicts", () => {
  beforeEach(() => {
    vi.stubEnv(CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV, "0");
    vi.stubEnv("ORACLE_WRAPPER_REMOTE_ONLY", "0");
    mocks.captureDirect.mockReset().mockRejectedValue(new Error("unexpected direct export"));
    mocks.captureObu.mockReset().mockRejectedValue(new Error("unexpected OBU export"));
    mocks.readSession.mockReset().mockRejectedValue(new Error("unexpected session read"));
    mocks.listSessions.mockReset().mockRejectedValue(new Error("unexpected session listing"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test.each(conflictCases)("rejects %s before target resolution", async (_name, options, error) => {
    await expect(handleChatGptExportCommand({ targetUrl, ...options })).rejects.toThrow(error);

    expect(mocks.readSession).not.toHaveBeenCalled();
    expect(mocks.listSessions).not.toHaveBeenCalled();
    expect(mocks.captureDirect).not.toHaveBeenCalled();
    expect(mocks.captureObu).not.toHaveBeenCalled();
  });

  test("keeps --browser-tab bound to the named Oracle session affinity", async () => {
    const metadata: SessionMetadata = {
      id: "session-a",
      createdAt: "2026-08-22T00:00:00.000Z",
      status: "completed",
      options: {},
      browser: {
        harvest: { conversationId: "thread-affinity", targetId: "target-a" },
        config: {
          remoteChrome: { host: "127.0.0.1", port: 9223 },
          remoteChromeBrowserId: "browser-a",
          remoteChromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
          remoteChromeAccountDigest: accountDigest,
        },
      },
    };
    mocks.readSession.mockResolvedValueOnce(metadata);
    mocks.captureDirect.mockRejectedValueOnce(new Error("named-session capture reached"));

    await expect(
      handleChatGptExportCommand({
        targetUrl,
        sessionId: "session-a",
        browserTab: "target-a",
      }),
    ).rejects.toThrow("named-session capture reached");

    expect(mocks.readSession).toHaveBeenCalledWith("session-a");
    expect(mocks.listSessions).not.toHaveBeenCalled();
    expect(mocks.captureDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl,
        tabRef: "target-a",
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        browserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
        accountDigest,
      }),
    );
    expect(mocks.captureObu).not.toHaveBeenCalled();
    const captureOptions = mocks.captureDirect.mock.calls[0]?.[0] as { outDir?: unknown };
    const outputLeaf = path.basename(String(captureOptions.outDir));
    expect(outputLeaf).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(outputLeaf).not.toContain("thread-affinity");
  });

  test("keeps auto-resolved stored affinity working", async () => {
    const metadata: SessionMetadata = {
      id: "session-auto",
      createdAt: "2026-08-22T00:00:00.000Z",
      status: "completed",
      options: {},
      browser: {
        harvest: { conversationId: "thread-affinity", targetId: "target-auto" },
        config: {
          remoteChrome: { host: "127.0.0.1", port: 9223 },
          remoteChromeBrowserId: "browser-auto",
          remoteChromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-auto",
          remoteChromeAccountDigest: accountDigest,
        },
      },
    };
    mocks.listSessions.mockResolvedValueOnce([metadata]);
    mocks.captureDirect.mockRejectedValueOnce(new Error("auto-session capture reached"));

    await expect(handleChatGptExportCommand({ targetUrl })).rejects.toThrow(
      "auto-session capture reached",
    );

    expect(mocks.readSession).not.toHaveBeenCalled();
    expect(mocks.listSessions).toHaveBeenCalledOnce();
    expect(mocks.captureDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl,
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-auto",
        browserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-auto",
        accountDigest,
      }),
    );
    expect(mocks.captureObu).not.toHaveBeenCalled();
  });

  test.each([
    ["raw remote Chrome", { remoteChrome: "127.0.0.1:9223" }],
    ["OBU", { obuSessionId: "obu-a", obuTabId: "tab-a" }],
  ] as const)(
    "rejects direct %s exports without authoritative affinity",
    async (_name, options) => {
      await expect(handleChatGptExportCommand({ targetUrl, ...options })).rejects.toThrow(
        /authoritative approved account affinity/i,
      );

      expect(mocks.readSession).not.toHaveBeenCalled();
      expect(mocks.listSessions).not.toHaveBeenCalled();
      expect(mocks.captureDirect).not.toHaveBeenCalled();
      expect(mocks.captureObu).not.toHaveBeenCalled();
    },
  );

  test("preserves the account-bound wrapper's stored-session restriction", async () => {
    vi.stubEnv(CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV, "1");

    await expect(
      handleChatGptExportCommand({
        targetUrl,
        sessionId: "session-a",
        remoteChrome: "127.0.0.1:9223",
        remoteChromeBrowserId: "browser-a",
        remoteChromeBrowserWs: "ws://127.0.0.1:9223/devtools/browser/browser-a",
        remoteChromeAccountDigest: accountDigest,
        expectedEmail: "owner@example.test",
        knownArchived: false,
      }),
    ).rejects.toThrow(/account-bound wrapper cannot be combined with stored sessions or OBU tabs/i);

    expect(mocks.readSession).not.toHaveBeenCalled();
    expect(mocks.listSessions).not.toHaveBeenCalled();
    expect(mocks.captureDirect).not.toHaveBeenCalled();
    expect(mocks.captureObu).not.toHaveBeenCalled();
  });
  test("rejects post-export archiving without the account-bound wrapper", async () => {
    await expect(
      handleChatGptExportCommand({ targetUrl, archiveAfterExport: true }),
    ).rejects.toThrow(/requires the account-bound wrapper/i);
    expect(mocks.listSessions).not.toHaveBeenCalled();
    expect(mocks.captureDirect).not.toHaveBeenCalled();
  });

  test("forwards post-export archiving for an active account-bound conversation", async () => {
    vi.stubEnv(CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV, "1");
    mocks.captureDirect.mockRejectedValueOnce(new Error("active archive capture reached"));

    await expect(
      handleChatGptExportCommand({
        targetUrl,
        remoteChrome: "127.0.0.1:9223",
        remoteChromeBrowserId: "browser-a",
        remoteChromeBrowserWs: "ws://127.0.0.1:9223/devtools/browser/browser-a",
        remoteChromeAccountDigest: accountDigest,
        expectedEmail: "owner@example.test",
        knownArchived: false,
        archiveAfterExport: true,
      }),
    ).rejects.toThrow("active archive capture reached");

    expect(mocks.captureDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        knownArchived: false,
        archiveAfterExport: true,
        expectedEmail: "owner@example.test",
      }),
    );
  });
});
