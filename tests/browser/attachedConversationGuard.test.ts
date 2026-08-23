import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type * as ChromeLifecycle from "../../src/browser/chromeLifecycle.js";
import type * as Cookies from "../../src/browser/cookies.js";
import type * as LiveTabs from "../../src/browser/liveTabs.js";
import type * as PageActions from "../../src/browser/pageActions.js";
import type * as ProfileState from "../../src/browser/profileState.js";
import type * as ProviderDomFlow from "../../src/browser/providerDomFlow.js";
const chromeMocks = vi.hoisted(() => ({
  launchChrome: vi.fn(),
}));
const cookieMocks = vi.hoisted(() => ({
  clearStaleChatGptConversationCookies: vi.fn(),
}));
const liveTabMocks = vi.hoisted(() => ({
  connectToExistingChatGptTab: vi.fn(),
}));
const providerFlowMocks = vi.hoisted(() => ({
  runProviderSubmissionFlow: vi.fn(),
}));
const pageActionMocks = vi.hoisted(() => ({
  captureAssistantMarkdown: vi.fn(),
  clearComposerAttachments: vi.fn(),
  clearPromptComposer: vi.fn(),
  ensureChatMode: vi.fn(),
  ensureLoggedIn: vi.fn(),
  ensureNotBlocked: vi.fn(),
  ensurePromptReady: vi.fn(),
  navigateToChatGPT: vi.fn(),
  readAssistantSnapshot: vi.fn(),
  readChatGptAccountDigest: vi.fn(),
  uploadAttachmentFile: vi.fn(),
  waitForAssistantResponse: vi.fn(),
}));
const remoteFileTransferMocks = vi.hoisted(() => ({
  uploadAttachmentViaDataTransfer: vi.fn(),
}));
const profileStateMocks = vi.hoisted(() => ({
  resolveRemoteChromeBrowserIdentity: vi.fn(),
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
vi.mock("../../src/browser/actions/remoteFileTransfer.js", () => remoteFileTransferMocks);
vi.mock("../../src/browser/profileState.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProfileState>()),
  ...profileStateMocks,
}));
vi.mock("../../src/browser/providerDomFlow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderDomFlow>()),
  ...providerFlowMocks,
}));

import { runBrowserMode } from "../../src/browser/index.js";

type Transport = "local" | "remote";
type RetargetPoint = "before-clear" | "before-upload";
type FirstConversationRetargetPoint = "before-pin" | "before-follow-up";
const transports = ["local", "remote"] as const;

function resetMocks(): void {
  chromeMocks.launchChrome.mockReset();
  cookieMocks.clearStaleChatGptConversationCookies.mockReset();
  liveTabMocks.connectToExistingChatGptTab.mockReset();
  providerFlowMocks.runProviderSubmissionFlow.mockReset();
  pageActionMocks.clearComposerAttachments.mockReset();
  pageActionMocks.captureAssistantMarkdown.mockReset();
  pageActionMocks.clearPromptComposer.mockReset();
  pageActionMocks.ensureChatMode.mockReset();
  pageActionMocks.navigateToChatGPT.mockReset();
  pageActionMocks.ensureLoggedIn.mockReset();
  pageActionMocks.ensureNotBlocked.mockReset();
  pageActionMocks.ensurePromptReady.mockReset();
  pageActionMocks.readAssistantSnapshot.mockReset();
  pageActionMocks.readChatGptAccountDigest.mockReset();
  pageActionMocks.uploadAttachmentFile.mockReset();
  pageActionMocks.waitForAssistantResponse.mockReset();
  remoteFileTransferMocks.uploadAttachmentViaDataTransfer.mockReset();
  profileStateMocks.resolveRemoteChromeBrowserIdentity.mockReset();
}

async function runWithRetargetedAttachedConversation(
  transport: Transport,
  retargetPoint: RetargetPoint,
): Promise<unknown> {
  const expectedUrl = "https://chatgpt.com/c/requested";
  const retargetedUrl = "https://chatgpt.com/c/retargeted";
  let currentUrl = retargetPoint === "before-clear" ? retargetedUrl : expectedUrl;
  const Runtime = {
    enable: vi.fn().mockResolvedValue({}),
    evaluate: vi.fn(async () => ({ result: { value: currentUrl } })),
  };
  const client = {
    DOM: {},
    Emulation: { setFocusEmulationEnabled: vi.fn().mockResolvedValue({}) },
    Input: {},
    Network: {
      clearBrowserCookies: vi.fn().mockResolvedValue({}),
      enable: vi.fn().mockResolvedValue({}),
    },
    Page: { enable: vi.fn().mockResolvedValue({}) },
    Runtime,
    Target: {},
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };

  vi.stubEnv("ORACLE_WRAPPER_EXPECTED_ACCOUNT_EMAIL", "");
  vi.stubEnv("ORACLE_WRAPPER_REMOTE_ONLY", "0");
  cookieMocks.clearStaleChatGptConversationCookies.mockResolvedValue(0);
  liveTabMocks.connectToExistingChatGptTab.mockResolvedValue({
    client,
    targetId: "target-1",
    tab: {
      conversationId: "requested",
      targetId: "target-1",
      url: expectedUrl,
    },
  });
  pageActionMocks.clearPromptComposer.mockResolvedValue(undefined);
  pageActionMocks.clearComposerAttachments.mockImplementation(async () => {
    if (retargetPoint === "before-upload") currentUrl = retargetedUrl;
  });
  pageActionMocks.ensureChatMode.mockResolvedValue("chat");
  pageActionMocks.ensureLoggedIn.mockResolvedValue(undefined);
  pageActionMocks.ensureNotBlocked.mockResolvedValue(undefined);
  pageActionMocks.ensurePromptReady.mockResolvedValue(undefined);
  pageActionMocks.readAssistantSnapshot.mockResolvedValue(null);
  pageActionMocks.readChatGptAccountDigest.mockResolvedValue("a".repeat(64));
  if (transport === "local") {
    chromeMocks.launchChrome.mockResolvedValue({
      kill: vi.fn().mockResolvedValue(undefined),
      pid: 1,
      port: 9222,
      process: undefined,
    });
  }

  const error = await runBrowserMode({
    prompt: "must not send",
    attachments: [{ displayPath: "/tmp/file.txt", path: "/tmp/file.txt" }],
    config: {
      archiveConversations: "never",
      browserTabRef: expectedUrl,
      cookieSync: false,
      headless: true,
      manualLogin: false,
      modelStrategy: "ignore",
      ...(transport === "remote" ? { remoteChrome: { host: "127.0.0.1", port: 9223 } } : {}),
    },
  }).catch((error: unknown) => error);

  return error;
}

async function runUnpinnedAttachmentRetarget(
  transport: Transport,
  browserTabRef: string,
  retargetPoint: FirstConversationRetargetPoint,
): Promise<unknown> {
  const initialUrl = browserTabRef.startsWith("https://chatgpt.com/g/")
    ? browserTabRef
    : "https://chatgpt.com/";
  const createdUrl = "https://chatgpt.com/c/created-for-run";
  const retargetedUrl = "https://chatgpt.com/c/retargeted";
  let currentUrl = initialUrl;
  let clearCount = 0;
  const answer = "a".repeat(100);
  const Runtime = {
    enable: vi.fn().mockResolvedValue({}),
    evaluate: vi.fn(async () => ({ result: { value: currentUrl } })),
  };
  const client = {
    DOM: {},
    Emulation: { setFocusEmulationEnabled: vi.fn().mockResolvedValue({}) },
    Input: {},
    Network: {
      clearBrowserCookies: vi.fn().mockResolvedValue({}),
      enable: vi.fn().mockResolvedValue({}),
    },
    Page: {
      enable: vi.fn().mockResolvedValue({}),
      navigate: vi.fn().mockResolvedValue({}),
      reload: vi.fn().mockResolvedValue({}),
    },
    Runtime,
    Target: {},
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };

  vi.stubEnv("ORACLE_WRAPPER_EXPECTED_ACCOUNT_EMAIL", "");
  vi.stubEnv("ORACLE_WRAPPER_REMOTE_ONLY", "0");
  cookieMocks.clearStaleChatGptConversationCookies.mockResolvedValue(0);
  liveTabMocks.connectToExistingChatGptTab.mockResolvedValue({
    client,
    targetId: "target-1",
    tab: {
      targetId: "target-1",
      title: "Unpinned ChatGPT",
      url: initialUrl,
    },
  });
  pageActionMocks.captureAssistantMarkdown.mockResolvedValue(answer);
  pageActionMocks.clearPromptComposer.mockImplementation(
    async (
      _runtime: unknown,
      _logger: unknown,
      assertPageAffinity?: (action: string) => Promise<void>,
    ) => {
      clearCount += 1;
      if (retargetPoint === "before-follow-up" && clearCount === 2) {
        currentUrl = retargetedUrl;
        await assertPageAffinity?.("follow-up prompt composer clearing");
      }
    },
  );
  pageActionMocks.ensureChatMode.mockResolvedValue("chat");
  pageActionMocks.ensureLoggedIn.mockResolvedValue(undefined);
  pageActionMocks.ensureNotBlocked.mockResolvedValue(undefined);
  pageActionMocks.ensurePromptReady.mockResolvedValue(undefined);
  pageActionMocks.readAssistantSnapshot.mockResolvedValue(null);
  pageActionMocks.readChatGptAccountDigest.mockResolvedValue("a".repeat(64));
  pageActionMocks.waitForAssistantResponse.mockResolvedValue({
    text: answer,
    meta: {},
  });
  providerFlowMocks.runProviderSubmissionFlow.mockImplementation(
    async (_adapter: unknown, context: { state?: Record<string, unknown> }) => {
      currentUrl = createdUrl;
      if (context.state) {
        context.state.baselineTurns = 0;
        await (context.state.onPromptSubmitted as (() => Promise<void>) | undefined)?.();
        context.state.committedConversationUrl = createdUrl;
      }
      if (retargetPoint === "before-pin") currentUrl = retargetedUrl;
    },
  );
  if (transport === "local") {
    chromeMocks.launchChrome.mockResolvedValue({
      kill: vi.fn().mockResolvedValue(undefined),
      pid: 1,
      port: 9222,
      process: undefined,
    });
  }

  return runBrowserMode({
    prompt: "initial",
    attachments: [],
    followUpPrompts: ["must not send"],
    config: {
      archiveConversations: "never",
      browserTabRef,
      cookieSync: false,
      headless: true,
      manualLogin: false,
      modelStrategy: "ignore",
      ...(transport === "remote" ? { remoteChrome: { host: "127.0.0.1", port: 9223 } } : {}),
    },
  }).catch((error: unknown) => error);
}

async function runAttachedWorkConversationReset(transport: Transport): Promise<unknown> {
  const workUrl = "https://chatgpt.com/c/work-thread";
  const createdUrl = "https://chatgpt.com/c/created-after-reset";
  const answer = "a".repeat(100);
  let currentUrl = workUrl;
  const Runtime = {
    enable: vi.fn().mockResolvedValue({}),
    evaluate: vi.fn(async () => ({ result: { value: currentUrl } })),
  };
  const client = {
    DOM: {},
    Emulation: { setFocusEmulationEnabled: vi.fn().mockResolvedValue({}) },
    Input: {},
    Network: {
      clearBrowserCookies: vi.fn().mockResolvedValue({}),
      enable: vi.fn().mockResolvedValue({}),
    },
    Page: {
      enable: vi.fn().mockResolvedValue({}),
      navigate: vi.fn().mockResolvedValue({}),
      reload: vi.fn().mockResolvedValue({}),
    },
    Runtime,
    Target: {},
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };

  vi.stubEnv("ORACLE_WRAPPER_EXPECTED_ACCOUNT_EMAIL", "");
  vi.stubEnv("ORACLE_WRAPPER_REMOTE_ONLY", "0");
  cookieMocks.clearStaleChatGptConversationCookies.mockResolvedValue(0);
  liveTabMocks.connectToExistingChatGptTab.mockResolvedValue({
    client,
    targetId: "target-1",
    tab: {
      conversationId: "work-thread",
      targetId: "target-1",
      url: workUrl,
    },
  });
  pageActionMocks.navigateToChatGPT.mockImplementation(
    async (_Page: unknown, _Runtime: unknown, url: string) => {
      currentUrl = url;
    },
  );
  pageActionMocks.ensureChatMode.mockImplementation(async (...args: unknown[]) => {
    const options = args[4] as { resetWorkConversation?: () => Promise<void> } | undefined;
    await options?.resetWorkConversation?.();
    return "switched";
  });
  pageActionMocks.captureAssistantMarkdown.mockResolvedValue(answer);
  pageActionMocks.clearPromptComposer.mockResolvedValue(undefined);
  pageActionMocks.ensureLoggedIn.mockResolvedValue(undefined);
  pageActionMocks.ensureNotBlocked.mockResolvedValue(undefined);
  pageActionMocks.ensurePromptReady.mockResolvedValue(undefined);
  pageActionMocks.readAssistantSnapshot.mockResolvedValue(null);
  pageActionMocks.readChatGptAccountDigest.mockResolvedValue("a".repeat(64));
  pageActionMocks.waitForAssistantResponse.mockResolvedValue({ text: answer, meta: {} });
  providerFlowMocks.runProviderSubmissionFlow.mockImplementation(
    async (_adapter: unknown, context: { state?: Record<string, unknown> }) => {
      currentUrl = createdUrl;
      if (!context.state) return;
      context.state.baselineTurns = 0;
      await (context.state.onPromptSubmitted as (() => Promise<void>) | undefined)?.();
      context.state.committedConversationUrl = createdUrl;
    },
  );
  if (transport === "local") {
    chromeMocks.launchChrome.mockResolvedValue({
      kill: vi.fn().mockResolvedValue(undefined),
      pid: 1,
      port: 9222,
      process: undefined,
    });
  }

  return runBrowserMode({
    prompt: "initial",
    config: {
      archiveConversations: "never",
      browserTabRef: workUrl,
      cookieSync: false,
      headless: true,
      manualLogin: false,
      modelStrategy: "ignore",
      ...(transport === "remote" ? { remoteChrome: { host: "127.0.0.1", port: 9223 } } : {}),
    },
  });
}

describe("attached conversation mutation guards", () => {
  beforeEach(() => {
    profileStateMocks.resolveRemoteChromeBrowserIdentity.mockResolvedValue({
      browserId: "browser-a",
      browserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetMocks();
  });

  test.each(transports)(
    "does not clear the composer after a %s attached conversation retarget",
    async (transport) => {
      const error = await runWithRetargetedAttachedConversation(transport, "before-clear");

      expect(error).toMatchObject({
        message: `ChatGPT conversation changed before ${transport === "remote" ? "submission" : "prompt"} preparation.`,
      });
      expect(pageActionMocks.clearPromptComposer).not.toHaveBeenCalled();
      expect(pageActionMocks.clearComposerAttachments).not.toHaveBeenCalled();
      expect(pageActionMocks.uploadAttachmentFile).not.toHaveBeenCalled();
      expect(remoteFileTransferMocks.uploadAttachmentViaDataTransfer).not.toHaveBeenCalled();
    },
  );

  test.each(transports)(
    "does not upload after a %s attached conversation retarget during attachment setup",
    async (transport) => {
      const error = await runWithRetargetedAttachedConversation(transport, "before-upload");

      expect(error).toMatchObject({
        message: "ChatGPT conversation changed before attachment upload.",
      });
      expect(pageActionMocks.clearPromptComposer).toHaveBeenCalledOnce();
      expect(pageActionMocks.clearComposerAttachments).toHaveBeenCalledOnce();
      expect(pageActionMocks.uploadAttachmentFile).not.toHaveBeenCalled();
      expect(remoteFileTransferMocks.uploadAttachmentViaDataTransfer).not.toHaveBeenCalled();
    },
  );

  test.each(
    transports.flatMap(
      (transport) =>
        [
          [transport, "root", "https://chatgpt.com/"],
          [transport, "project", "https://chatgpt.com/g/g-p-test/project"],
        ] as const,
    ),
  )(
    "rejects a %s %s retarget after submitted-turn evidence but before first pin",
    async (transport, _label, browserTabRef) => {
      const error = await runUnpinnedAttachmentRetarget(transport, browserTabRef, "before-pin");

      expect(error).toMatchObject({
        message: "ChatGPT conversation changed before response handling.",
      });
      expect(pageActionMocks.waitForAssistantResponse).not.toHaveBeenCalled();
      expect(pageActionMocks.clearPromptComposer).toHaveBeenCalledOnce();
    },
  );

  test.each(
    transports.flatMap(
      (transport) =>
        [
          [transport, "root URL", "https://chatgpt.com/"],
          [transport, "current", "current"],
          [transport, "target id", "target-1"],
          [transport, "title", "Root ChatGPT"],
        ] as const,
    ),
  )(
    "pins the first created conversation for a %s %s attachment",
    async (transport, _label, browserTabRef) => {
      const error = await runUnpinnedAttachmentRetarget(
        transport,
        browserTabRef,
        "before-follow-up",
      );

      expect(error).toMatchObject({
        message: "ChatGPT conversation changed before follow-up prompt composer clearing.",
      });
      expect(providerFlowMocks.runProviderSubmissionFlow).toHaveBeenCalledOnce();
      expect(pageActionMocks.waitForAssistantResponse).toHaveBeenCalledOnce();
      expect(pageActionMocks.clearPromptComposer).toHaveBeenCalledTimes(2);
    },
  );
  test.each(transports)(
    "releases the attached %s Work conversation pin before starting a new Chat",
    async (transport) => {
      await expect(runAttachedWorkConversationReset(transport)).resolves.toMatchObject({
        conversationId: "created-after-reset",
        promptSubmitted: true,
      });
      expect(pageActionMocks.navigateToChatGPT).toHaveBeenCalledOnce();
      expect(providerFlowMocks.runProviderSubmissionFlow).toHaveBeenCalledOnce();
    },
  );
});
