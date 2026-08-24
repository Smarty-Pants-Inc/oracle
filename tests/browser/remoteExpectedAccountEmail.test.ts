import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type * as ChatGptAccount from "../../src/browser/chatgptAccount.js";
import type * as ChromeLifecycle from "../../src/browser/chromeLifecycle.js";
import type * as Cookies from "../../src/browser/cookies.js";
import type * as LiveTabs from "../../src/browser/liveTabs.js";
import type * as PageActions from "../../src/browser/pageActions.js";
import type * as ProfileState from "../../src/browser/profileState.js";
const accountMocks = vi.hoisted(() => ({
  assertChatGptAccountEmail: vi.fn(),
}));
const chromeMocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  connectToRemoteChrome: vi.fn(),
}));
const cookieMocks = vi.hoisted(() => ({
  clearStaleChatGptConversationCookies: vi.fn(),
}));
const liveTabMocks = vi.hoisted(() => ({
  connectToExistingChatGptTab: vi.fn(),
}));
const pageActionMocks = vi.hoisted(() => ({
  ensureLoggedIn: vi.fn(),
  ensureNotBlocked: vi.fn(),
  ensurePromptReady: vi.fn(),
  navigateToChatGPT: vi.fn(),
  readChatGptAccountDigest: vi.fn(),
}));
const profileStateMocks = vi.hoisted(() => ({
  resolveRemoteChromeBrowserIdentity: vi.fn(),
}));

vi.mock("../../src/browser/chatgptAccount.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ChatGptAccount>()),
  ...accountMocks,
}));
vi.mock("../../src/browser/chromeLifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ChromeLifecycle>()),
  ...chromeMocks,
}));
vi.mock("../../src/browser/cookies.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Cookies>()),
  ...cookieMocks,
}));
vi.mock("../../src/browser/liveTabs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LiveTabs>()),
  ...liveTabMocks,
}));
vi.mock("../../src/browser/pageActions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PageActions>()),
  ...pageActionMocks,
}));
vi.mock("../../src/browser/profileState.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProfileState>()),
  ...profileStateMocks,
}));

import { runBrowserMode } from "../../src/browser/index.js";

describe("remote expected account email guard", () => {
  beforeEach(() => {
    profileStateMocks.resolveRemoteChromeBrowserIdentity.mockResolvedValue({
      browserId: "browser-a",
      browserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    accountMocks.assertChatGptAccountEmail.mockReset();
    chromeMocks.closeTab.mockReset();
    chromeMocks.connectToRemoteChrome.mockReset();
    cookieMocks.clearStaleChatGptConversationCookies.mockReset();
    liveTabMocks.connectToExistingChatGptTab.mockReset();
    pageActionMocks.ensureLoggedIn.mockReset();
    pageActionMocks.ensureNotBlocked.mockReset();
    pageActionMocks.ensurePromptReady.mockReset();
    pageActionMocks.navigateToChatGPT.mockReset();
    pageActionMocks.readChatGptAccountDigest.mockReset();
    profileStateMocks.resolveRemoteChromeBrowserIdentity.mockReset();
  });

  test("verifies the expected email on a neutral bound target before resolving tabs or cookies", async () => {
    const events: string[] = [];
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const neutralClient = {
      Page: { enable: vi.fn().mockResolvedValue({}) },
      Runtime: { enable: vi.fn().mockResolvedValue({}) },
    };
    const closeVerificationTarget = vi.fn(async () => {
      events.push("close neutral target");
    });
    const existingClient = {
      DOM: undefined,
      Emulation: { setFocusEmulationEnabled: vi.fn().mockResolvedValue({}) },
      Input: {},
      Network: { enable: vi.fn().mockResolvedValue({}) },
      Page: { enable: vi.fn().mockResolvedValue({}) },
      Runtime: { enable: vi.fn().mockResolvedValue({}) },
      Target: {},
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };

    vi.stubEnv("ORACLE_WRAPPER_EXPECTED_ACCOUNT_EMAIL", "owner@example.test");
    vi.stubEnv("ORACLE_WRAPPER_REMOTE_ONLY", "0");
    chromeMocks.connectToRemoteChrome.mockImplementation(async () => {
      events.push("open neutral target");
      return {
        client: neutralClient,
        targetId: "neutral-target",
        close: closeVerificationTarget,
      };
    });
    pageActionMocks.navigateToChatGPT.mockImplementation(async () => {
      events.push("navigate neutral target");
    });
    pageActionMocks.ensureNotBlocked.mockImplementation(async () => {
      events.push("inspect block state");
    });
    pageActionMocks.ensureLoggedIn.mockImplementation(async () => {
      events.push("inspect login state");
    });
    accountMocks.assertChatGptAccountEmail.mockImplementation(async () => {
      events.push("verify expected email");
      throw new Error("expected account mismatch");
    });
    liveTabMocks.connectToExistingChatGptTab.mockImplementation(async () => {
      events.push("resolve existing tab");
      return {
        client: existingClient,
        targetId: "existing-target",
        tab: { url: "https://chatgpt.com/c/existing" },
      };
    });
    cookieMocks.clearStaleChatGptConversationCookies.mockImplementation(async () => {
      events.push("inspect or delete cookies");
      return 0;
    });

    await expect(
      runBrowserMode({
        prompt: "must not send",
        config: {
          browserTabRef: "current",
          remoteChrome: { host: "127.0.0.1", port: 9223 },
          remoteChromeBrowserWSEndpoint: browserWSEndpoint,
        },
      }),
    ).rejects.toThrow("expected account mismatch");

    expect(chromeMocks.connectToRemoteChrome).toHaveBeenCalledWith(
      "127.0.0.1",
      9223,
      expect.any(Function),
      "https://chatgpt.com/",
      browserWSEndpoint,
      expect.objectContaining({ approvalWaitMs: undefined }),
    );
    expect(pageActionMocks.navigateToChatGPT).toHaveBeenCalledWith(
      neutralClient.Page,
      neutralClient.Runtime,
      "https://chatgpt.com/",
      expect.any(Function),
    );
    expect(accountMocks.assertChatGptAccountEmail).toHaveBeenCalledWith(
      neutralClient.Runtime,
      "owner@example.test",
      "Oracle remote browser initialization",
      expect.any(Number),
    );
    expect(closeVerificationTarget).toHaveBeenCalledOnce();
    expect(liveTabMocks.connectToExistingChatGptTab).not.toHaveBeenCalled();
    expect(cookieMocks.clearStaleChatGptConversationCookies).not.toHaveBeenCalled();
    expect(pageActionMocks.ensureLoggedIn).not.toHaveBeenCalled();
    expect(events).toEqual([
      "open neutral target",
      "navigate neutral target",
      "verify expected email",
      "close neutral target",
    ]);
  });
  test("aggregates expected-email and neutral-target cleanup failures", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const verificationError = new Error("expected account mismatch");
    const cleanupError = new Error("neutral target cleanup failed");
    const close = vi.fn().mockRejectedValue(cleanupError);
    const neutralClient = {
      Page: { enable: vi.fn().mockResolvedValue({}) },
      Runtime: { enable: vi.fn().mockResolvedValue({}) },
    };

    vi.stubEnv("ORACLE_WRAPPER_EXPECTED_ACCOUNT_EMAIL", "owner@example.test");
    vi.stubEnv("ORACLE_WRAPPER_REMOTE_ONLY", "0");
    chromeMocks.connectToRemoteChrome.mockResolvedValue({
      client: neutralClient,
      targetId: "neutral-target",
      close,
    });
    pageActionMocks.navigateToChatGPT.mockResolvedValue(undefined);
    accountMocks.assertChatGptAccountEmail.mockRejectedValue(verificationError);

    const error = await runBrowserMode({
      prompt: "must not send",
      config: {
        browserTabRef: "current",
        remoteChrome: { host: "127.0.0.1", port: 9223 },
        remoteChromeBrowserWSEndpoint: browserWSEndpoint,
      },
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([verificationError, cleanupError]);
    expect(close).toHaveBeenCalledOnce();
    expect(liveTabMocks.connectToExistingChatGptTab).not.toHaveBeenCalled();
    expect(cookieMocks.clearStaleChatGptConversationCookies).not.toHaveBeenCalled();
  });
  test("surfaces neutral-target cleanup failure after a successful account check", async () => {
    const cleanupError = new Error("neutral target cleanup failed");
    const close = vi.fn().mockRejectedValue(cleanupError);
    const neutralClient = {
      Page: { enable: vi.fn().mockResolvedValue({}) },
      Runtime: { enable: vi.fn().mockResolvedValue({}) },
    };

    vi.stubEnv("ORACLE_WRAPPER_EXPECTED_ACCOUNT_EMAIL", "owner@example.test");
    vi.stubEnv("ORACLE_WRAPPER_REMOTE_ONLY", "0");
    chromeMocks.connectToRemoteChrome.mockResolvedValue({
      client: neutralClient,
      targetId: "neutral-target",
      close,
    });
    pageActionMocks.navigateToChatGPT.mockResolvedValue(undefined);
    accountMocks.assertChatGptAccountEmail.mockResolvedValue("a".repeat(64));

    const error = await runBrowserMode({
      prompt: "must not send",
      config: {
        browserTabRef: "current",
        remoteChrome: { host: "127.0.0.1", port: 9223 },
      },
    }).catch((error: unknown) => error);

    expect(error).toBe(cleanupError);
    expect(close).toHaveBeenCalledOnce();
    expect(liveTabMocks.connectToExistingChatGptTab).not.toHaveBeenCalled();
    expect(cookieMocks.clearStaleChatGptConversationCookies).not.toHaveBeenCalled();
  });
  test("navigates a fresh verified remote target to its configured project before submission", async () => {
    const accountDigest = "a".repeat(64);
    const projectUrl = "https://chatgpt.com/g/g-p-test/project";
    const stop = new Error("stop after configured target navigation");
    const client = {
      DOM: undefined,
      Emulation: { setFocusEmulationEnabled: vi.fn().mockResolvedValue({}) },
      Input: {},
      Network: { enable: vi.fn().mockResolvedValue({}) },
      Page: { enable: vi.fn().mockResolvedValue({}) },
      Runtime: { enable: vi.fn().mockResolvedValue({}) },
      Target: {},
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };

    vi.stubEnv("ORACLE_WRAPPER_EXPECTED_ACCOUNT_EMAIL", "");
    vi.stubEnv("ORACLE_WRAPPER_REMOTE_ONLY", "0");
    chromeMocks.connectToRemoteChrome.mockResolvedValue({
      client,
      targetId: "fresh-target",
      close: vi.fn().mockResolvedValue(undefined),
    });
    chromeMocks.closeTab.mockResolvedValue(true);
    cookieMocks.clearStaleChatGptConversationCookies.mockResolvedValue(0);
    pageActionMocks.ensureLoggedIn.mockResolvedValue(undefined);
    pageActionMocks.ensureNotBlocked.mockResolvedValue(undefined);
    pageActionMocks.ensurePromptReady.mockRejectedValue(stop);
    pageActionMocks.navigateToChatGPT.mockResolvedValue(undefined);
    pageActionMocks.readChatGptAccountDigest.mockResolvedValue(accountDigest);

    const error = await runBrowserMode({
      prompt: "must not submit",
      config: {
        archiveConversations: "never",
        modelStrategy: "ignore",
        remoteChrome: { host: "127.0.0.1", port: 9223 },
        remoteChromeAccountDigest: accountDigest,
        url: projectUrl,
      },
    }).catch((error: unknown) => error);

    expect(error).toBe(stop);
    expect(pageActionMocks.readChatGptAccountDigest).toHaveBeenCalledTimes(2);
    expect(pageActionMocks.navigateToChatGPT).toHaveBeenNthCalledWith(
      1,
      client.Page,
      client.Runtime,
      "https://chatgpt.com/",
      expect.any(Function),
    );
    expect(pageActionMocks.navigateToChatGPT).toHaveBeenNthCalledWith(
      2,
      client.Page,
      client.Runtime,
      projectUrl,
      expect.any(Function),
    );
  });
});
