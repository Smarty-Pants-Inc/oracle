import { afterEach, describe, expect, test, vi } from "vitest";
import { handleChatGptInventoryCommand } from "../../src/cli/chatgptInventory.js";
import { CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV } from "../../src/cli/chatgptRemoteAffinity.js";

const mocks = vi.hoisted(() => ({
  captureInventory: vi.fn(),
}));

vi.mock("../../src/browser/chatgptInventory.js", () => ({
  captureChatGptConversationInventory: mocks.captureInventory,
}));

describe("chatgpt-inventory JSON output", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.captureInventory.mockReset();
    vi.unstubAllEnvs();
  });

  test("prints compact single-line JSON", async () => {
    const result = {
      accountDigest: "a".repeat(64),
      items: [
        {
          conversationId: "conversation-1",
          title: "Inventory item",
          createdAt: "2026-08-22T00:00:00.000Z",
          updatedAt: null,
          archived: false,
          url: "https://chatgpt.com/c/conversation-1",
        },
      ],
    };
    mocks.captureInventory.mockResolvedValue(result);
    vi.stubEnv(CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV, "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await handleChatGptInventoryCommand({
      remoteChrome: "127.0.0.1:9223",
      remoteChromeBrowserId: "browser-a",
      remoteChromeBrowserWs: "ws://127.0.0.1:9223/devtools/browser/browser-a",
      expectedEmail: "owner@example.test",
      json: true,
    });

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(JSON.stringify(result));
    expect(log.mock.calls[0]?.[0]).not.toMatch(/[\r\n]/);
    expect(log.mock.calls[0]?.[0]).not.toContain(": ");
  });

  test("converts the inherited timeout from seconds to milliseconds", async () => {
    mocks.captureInventory.mockResolvedValue({ accountDigest: "a".repeat(64), items: [] });
    vi.stubEnv(CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV, "1");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await handleChatGptInventoryCommand({
      remoteChrome: "127.0.0.1:9223",
      remoteChromeBrowserId: "browser-a",
      remoteChromeBrowserWs: "ws://127.0.0.1:9223/devtools/browser/browser-a",
      expectedEmail: "owner@example.test",
      json: true,
      timeout: 300,
    });

    expect(mocks.captureInventory).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });
});
