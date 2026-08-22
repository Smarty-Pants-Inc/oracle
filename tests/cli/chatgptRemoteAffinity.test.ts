import { afterEach, describe, expect, test, vi } from "vitest";
import { handleChatGptExportCommand } from "../../src/cli/chatgptExport.js";
import { handleChatGptInventoryCommand } from "../../src/cli/chatgptInventory.js";
import {
  CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV,
  resolveChatGptRemoteAccountAffinity,
  resolveChatGptRemoteEmailAffinity,
} from "../../src/cli/chatgptRemoteAffinity.js";

describe("ChatGPT account-bound wrapper CLI affinity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("requires and normalizes the complete hidden affinity contract", () => {
    expect(
      resolveChatGptRemoteAccountAffinity({
        remoteChrome: "127.0.0.1:9223",
        remoteChromeBrowserId: "browser-a",
        remoteChromeBrowserWs: "ws://127.0.0.1:9223/devtools/browser/browser-a",
        remoteChromeAccountDigest: "a".repeat(64),
        expectedEmail: " OWNER@EXAMPLE.TEST ",
      }),
    ).toEqual({
      host: "127.0.0.1",
      port: 9223,
      browserId: "browser-a",
      browserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
      accountDigest: "a".repeat(64),
      expectedEmail: "owner@example.test",
    });
    expect(
      resolveChatGptRemoteEmailAffinity({
        remoteChrome: "127.0.0.1:9223",
        remoteChromeBrowserId: "browser-a",
        remoteChromeBrowserWs: "ws://127.0.0.1:9223/devtools/browser/browser-a",
        expectedEmail: " OWNER@EXAMPLE.TEST ",
      }),
    ).toEqual({
      host: "127.0.0.1",
      port: 9223,
      browserId: "browser-a",
      browserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
      expectedEmail: "owner@example.test",
    });

    expect(() => resolveChatGptRemoteAccountAffinity({ remoteChrome: "127.0.0.1:9223" })).toThrow(
      /requires --remote-chrome.*--expected-email together/i,
    );
  });

  test.each([
    "ws://attacker.invalid:9223/devtools/browser/browser-a",
    "ws://127.0.0.1:9444/devtools/browser/browser-a",
    "ws://user@127.0.0.1:9223/devtools/browser/browser-a",
    "ws://127.0.0.1:9223/devtools/browser/browser-a?token=secret",
  ])("rejects a browser WebSocket outside the configured authority: %s", (browserWSEndpoint) => {
    expect(() =>
      resolveChatGptRemoteEmailAffinity({
        remoteChrome: "127.0.0.1:9223",
        remoteChromeBrowserId: "browser-a",
        remoteChromeBrowserWs: browserWSEndpoint,
        expectedEmail: "owner@example.test",
      }),
    ).toThrow(/authority|invalid/i);
  });

  test("rejects direct affinity flags without the dedicated wrapper marker", async () => {
    await expect(
      handleChatGptExportCommand({
        targetUrl: "https://chatgpt.com/c/conv-1",
        remoteChrome: "127.0.0.1:9223",
        remoteChromeBrowserId: "browser-a",
      }),
    ).rejects.toThrow(new RegExp(`${CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV}=1`, "i"));
  });

  test("inventory requires the dedicated marker and JSON output", async () => {
    await expect(
      handleChatGptInventoryCommand({ remoteChrome: "127.0.0.1:9223", json: true }),
    ).rejects.toThrow(new RegExp(`${CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV}=1`, "i"));

    vi.stubEnv(CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV, "1");
    await expect(handleChatGptInventoryCommand({ remoteChrome: "127.0.0.1:9223" })).rejects.toThrow(
      /requires --json/i,
    );
  });

  test("dedicated wrapper requires the inventory archive state", async () => {
    vi.stubEnv(CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV, "1");
    await expect(
      handleChatGptExportCommand({
        targetUrl: "https://chatgpt.com/c/conv-1",
        remoteChrome: "127.0.0.1:9223",
        remoteChromeBrowserId: "browser-a",
        remoteChromeBrowserWs: "ws://127.0.0.1:9223/devtools/browser/browser-a",
        remoteChromeAccountDigest: "a".repeat(64),
        expectedEmail: "owner@example.test",
      }),
    ).rejects.toThrow(/requires the inventory's known archive state/i);
  });

  test("dedicated wrapper rejects archiving an already archived conversation", async () => {
    vi.stubEnv(CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV, "1");
    await expect(
      handleChatGptExportCommand({
        targetUrl: "https://chatgpt.com/c/conv-1",
        remoteChrome: "127.0.0.1:9223",
        remoteChromeBrowserId: "browser-a",
        remoteChromeBrowserWs: "ws://127.0.0.1:9223/devtools/browser/browser-a",
        remoteChromeAccountDigest: "a".repeat(64),
        expectedEmail: "owner@example.test",
        knownArchived: true,
        archiveAfterExport: true,
      }),
    ).rejects.toThrow(/already archived/i);
  });
});
