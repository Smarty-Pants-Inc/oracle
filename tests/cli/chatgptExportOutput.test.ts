import { afterEach, describe, expect, test, vi } from "vitest";
import type * as ChatGptExportModule from "../../src/browser/chatgptExport.js";
import type * as SessionStoreModule from "../../src/sessionStore.js";

const exportMocks = vi.hoisted(() => ({
  captureApprovedChatGptConversationBackend: vi.fn(),
  captureApprovedChatGptConversationBackendViaObu: vi.fn(),
}));
const sessionStoreMocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  readSession: vi.fn(),
}));

vi.mock("../../src/browser/chatgptExport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ChatGptExportModule>()),
  ...exportMocks,
}));
vi.mock("../../src/sessionStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionStoreModule>()),
  sessionStore: sessionStoreMocks,
}));
import { handleChatGptExportCommand } from "../../src/cli/chatgptExport.js";

describe("ChatGPT export CLI output", () => {
  afterEach(() => {
    exportMocks.captureApprovedChatGptConversationBackend.mockReset();
    exportMocks.captureApprovedChatGptConversationBackendViaObu.mockReset();
    sessionStoreMocks.listSessions.mockReset();
    sessionStoreMocks.readSession.mockReset();
    vi.restoreAllMocks();
  });

  test("prints cleanup warnings to stderr without discarding the completed export", async () => {
    const targetUrl = "https://chatgpt.com/c/thread-warning";
    sessionStoreMocks.listSessions.mockResolvedValue([
      {
        id: "session-warning",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        options: {},
        browser: {
          config: {
            url: targetUrl,
            remoteChrome: { host: "127.0.0.1", port: 9223 },
            remoteChromeBrowserId: "browser-a",
            remoteChromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
            remoteChromeAccountDigest: "a".repeat(64),
          },
        },
      },
    ]);
    exportMocks.captureApprovedChatGptConversationBackend.mockResolvedValue({
      ok: true,
      outputDir: "/tmp/export-warning",
      targetUrl,
      targetApiUrl: "https://chatgpt.com/backend-api/conversation/thread-warning",
      conversationId: "thread-warning",
      targetId: "target-a",
      tabUrl: targetUrl,
      rawBackendPath: "/tmp/export-warning/raw.json",
      rawBackendSha256: "a".repeat(64),
      rawBackendSizeBytes: 10,
      payloadPath: "/tmp/export-warning/payload.json",
      markdownPath: "/tmp/export-warning/conversation.md",
      manifestPath: "/tmp/export-warning/manifest.json",
      captureInfoPath: "/tmp/export-warning/capture.json",
      sha256SumsPath: "/tmp/export-warning/SHA256SUMS",
      mappingCount: 1,
      currentPathNodeCount: 1,
      turnCount: 1,
      stats: {},
      archiveRecovery: { attempted: false, recovered: false, status: "not-needed" },
      cleanupWarnings: ["ChatGPT export target cleanup could not be confirmed."],
    });
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleChatGptExportCommand({ targetUrl, out: "/tmp/export-warning" });

    expect(stdout).toHaveBeenCalledWith("ChatGPT conversation export complete");
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("ChatGPT export target cleanup could not be confirmed."),
    );
  });
});
