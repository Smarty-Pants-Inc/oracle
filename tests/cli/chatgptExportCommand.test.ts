import { beforeEach, describe, expect, test, vi } from "vitest";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

const mocks = vi.hoisted(() => ({
  readSession: vi.fn(),
  listSessions: vi.fn(),
  updateSession: vi.fn(),
  captureViaObu: vi.fn(),
  captureViaCdp: vi.fn(),
}));

vi.mock("../../src/sessionStore.ts", () => ({
  sessionStore: {
    readSession: mocks.readSession,
    listSessions: mocks.listSessions,
    updateSession: mocks.updateSession,
  },
}));

vi.mock("../../src/browser/chatgptExport.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/browser/chatgptExport.js")>();
  return {
    ...actual,
    captureApprovedChatGptConversationBackend: mocks.captureViaCdp,
    captureApprovedChatGptConversationBackendViaObu: mocks.captureViaObu,
  };
});

import { handleChatGptExportCommand } from "../../src/cli/chatgptExport.js";

const targetUrl = "https://chatgpt.com/c/export-thread";

function obuSession(): SessionMetadata {
  const route = {
    browserTransport: "obu" as const,
    obuSessionId: "oracle-main",
    obuTabId: 7,
    chatGptAccountEmail: "paul@smartypants.ai",
    chatGptWorkspaceName: "Paul Bettner",
    chatGptAccountDigest: "a".repeat(64),
    chatGptWorkspaceDigest: "b".repeat(64),
  };
  return {
    id: "export-session",
    createdAt: "2026-08-22T00:00:00.000Z",
    status: "completed",
    options: { browserConfig: route },
    browser: {
      config: route,
      runtime: {
        ...route,
        tabUrl: targetUrl,
        conversationId: "export-thread",
        promptMessageId: "prompt-message",
        assistantMessageId: "assistant-message",
      },
    },
  };
}

describe("ChatGPT export operation errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateSession.mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  test("clears a stale export-owned error after retry without replacing the primary error", async () => {
    const meta = obuSession();
    meta.errorMessage = "primary run failed";
    meta.error = { category: "browser-automation", message: "primary run failed" };
    const signedUrl = "https://chatgpt.com/c/private-other-thread?signature=export-secret#x";
    mocks.readSession.mockResolvedValue(meta);
    mocks.captureViaObu
      .mockRejectedValueOnce(
        new BrowserAutomationError(`Export tab lost its routed account at ${signedUrl}`, {
          stage: "main-chrome-account-router",
          code: "account-identity-mismatch",
          actualUrl: signedUrl,
          recoveryHandle: {
            transport: "obu",
            sessionId: "oracle-main",
            tabId: 7,
            conversationUrl: signedUrl,
          },
          sessionStatus: "needs_login",
        }),
      )
      .mockResolvedValueOnce({ targetUrl, conversationId: "export-thread" });

    await expect(
      handleChatGptExportCommand({ targetUrl, sessionId: meta.id, json: true }),
    ).rejects.toMatchObject({
      details: {
        stage: "main-chrome-account-router",
        code: "account-identity-mismatch",
      },
    });
    const failedUpdate = mocks.updateSession.mock.calls.at(-1)?.[1] as
      | Partial<SessionMetadata>
      | undefined;
    const operationError = failedUpdate?.browser?.operationErrors?.["chatgpt-export"];
    expect(operationError).toMatchObject({
      message: "Export tab lost its routed account at [redacted-url]",
      details: {
        oracleOperation: "chatgpt-export",
        stage: "main-chrome-account-router",
        code: "account-identity-mismatch",
        sessionStatus: "needs_login",
        recoveryHandle: {
          transport: "obu",
          sessionId: "oracle-main",
          tabId: 7,
          conversationUrl: "[redacted-url]",
        },
      },
    });
    expect(operationError?.details).not.toHaveProperty("actualUrl");
    expect(JSON.stringify(operationError)).not.toContain(signedUrl);
    expect(JSON.stringify(operationError)).not.toContain("export-secret");
    expect(failedUpdate).not.toHaveProperty("error");
    meta.browser = failedUpdate?.browser;
    expect(meta.error?.message).toBe("primary run failed");
    mocks.updateSession.mockClear();

    await expect(
      handleChatGptExportCommand({ targetUrl, sessionId: meta.id, json: true }),
    ).resolves.toBeUndefined();
    expect(mocks.captureViaCdp).not.toHaveBeenCalled();
    expect(mocks.captureViaObu).toHaveBeenLastCalledWith(
      expect.objectContaining({
        oracleSessionId: meta.id,
        obuSessionId: "oracle-main",
        obuTabId: 7,
        turnAffinity: {
          promptMessageId: "prompt-message",
          assistantMessageId: "assistant-message",
        },
      }),
    );
    expect(mocks.updateSession).toHaveBeenCalledWith(meta.id, {
      browser: expect.objectContaining({ operationErrors: undefined }),
    });
    expect(meta.error?.message).toBe("primary run failed");
  });

  test("does not persist arbitrary generic export error text", async () => {
    const meta = obuSession();
    const privateUrl = "https://chatgpt.com/c/private-other-thread";
    mocks.readSession.mockResolvedValue(meta);
    mocks.captureViaObu.mockRejectedValue(new Error(`Export failed at ${privateUrl}`));

    await expect(
      handleChatGptExportCommand({ targetUrl, sessionId: meta.id, json: true }),
    ).rejects.toThrow(privateUrl);

    const failedUpdate = mocks.updateSession.mock.calls.at(-1)?.[1] as
      | Partial<SessionMetadata>
      | undefined;
    const operationError = failedUpdate?.browser?.operationErrors?.["chatgpt-export"];
    expect(operationError?.message).toBe(
      "ChatGPT export failed. Rerun the export to see the current error.",
    );
    expect(JSON.stringify(operationError)).not.toContain(privateUrl);
  });

  test("passes exact post-export archive cleanup to the main-Chrome exporter", async () => {
    const meta = obuSession();
    mocks.readSession.mockResolvedValue(meta);
    mocks.captureViaObu.mockResolvedValue({ targetUrl, conversationId: "export-thread" });

    await expect(
      handleChatGptExportCommand({
        targetUrl,
        sessionId: meta.id,
        archiveAfterExport: true,
        json: true,
      }),
    ).resolves.toBeUndefined();
    expect(mocks.captureViaObu).toHaveBeenCalledWith(
      expect.objectContaining({ archiveAfterExport: true }),
    );
    expect(mocks.captureViaCdp).not.toHaveBeenCalled();
  });

  test("rejects unsupported archived recovery control for main-Chrome exports", async () => {
    const meta = obuSession();
    mocks.readSession.mockResolvedValue(meta);

    await expect(
      handleChatGptExportCommand({
        targetUrl,
        sessionId: meta.id,
        recoverArchived: false,
        json: true,
      }),
    ).rejects.toThrow(/no-recover-archived.*unavailable/i);
    expect(mocks.captureViaObu).not.toHaveBeenCalled();
    expect(mocks.captureViaCdp).not.toHaveBeenCalled();
  });
  test("rejects an explicit remote endpoint that would bypass a named OBU session", async () => {
    const meta = obuSession();
    mocks.readSession.mockResolvedValue(meta);

    await expect(
      handleChatGptExportCommand({
        targetUrl,
        sessionId: meta.id,
        remoteChrome: "127.0.0.1:9223",
        json: true,
      }),
    ).rejects.toThrow(/cannot override a named main-Chrome session/i);
    expect(mocks.captureViaObu).not.toHaveBeenCalled();
    expect(mocks.captureViaCdp).not.toHaveBeenCalled();
  });

  test("rejects a caller-selected browser tab for a named OBU session", async () => {
    const meta = obuSession();
    mocks.readSession.mockResolvedValue(meta);

    await expect(
      handleChatGptExportCommand({
        targetUrl,
        sessionId: meta.id,
        browserTab: "tab-7",
        json: true,
      }),
    ).rejects.toThrow(/stored task-tab affinity.*remove --browser-tab/i);
    expect(mocks.captureViaObu).not.toHaveBeenCalled();
  });

  test("rejects an explicit endpoint that differs from a named CDP session", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const config = {
      remoteChrome: { host: "127.0.0.1", port: 9223 },
      remoteChromeBrowserId: "browser-a",
      remoteChromeBrowserWSEndpoint: browserWSEndpoint,
      remoteChromeAccountDigest: "a".repeat(64),
    };
    const meta: SessionMetadata = {
      id: "cdp-session",
      createdAt: "2026-08-22T00:00:00.000Z",
      status: "completed",
      options: { browserConfig: config },
      browser: {
        config,
        runtime: {
          chromeBrowserWSEndpoint: browserWSEndpoint,
          chatGptAccountDigest: "a".repeat(64),
          tabUrl: targetUrl,
          conversationId: "export-thread",
        },
      },
    };
    mocks.readSession.mockResolvedValue(meta);

    await expect(
      handleChatGptExportCommand({
        targetUrl,
        sessionId: meta.id,
        remoteChrome: "127.0.0.1:9333",
        json: true,
      }),
    ).rejects.toThrow(/does not match the named session's stored browser endpoint/i);
    expect(mocks.captureViaCdp).not.toHaveBeenCalled();
  });
});
