import { afterEach, describe, expect, test, vi } from "vitest";
import type * as ChromeLifecycle from "../../src/browser/chromeLifecycle.js";
import type * as Cookies from "../../src/browser/cookies.js";
import type * as DeepResearch from "../../src/browser/actions/deepResearch.js";
import type * as PageActions from "../../src/browser/pageActions.js";
import type * as ProviderDomFlow from "../../src/browser/providerDomFlow.js";
import type * as ProfileState from "../../src/browser/profileState.js";

const chromeMocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  connectToRemoteChrome: vi.fn(),
}));
const cookieMocks = vi.hoisted(() => ({
  clearStaleChatGptConversationCookies: vi.fn(),
}));
const deepResearchMocks = vi.hoisted(() => ({
  activateDeepResearch: vi.fn(),
  captureDeepResearchTargetKeys: vi.fn(),
  waitForDeepResearchCompletion: vi.fn(),
  waitForResearchPlanAutoConfirm: vi.fn(),
}));
const pageActionMocks = vi.hoisted(() => ({
  clearPromptComposer: vi.fn(),
  ensureChatMode: vi.fn(),
  ensureLoggedIn: vi.fn(),
  ensureNotBlocked: vi.fn(),
  ensurePromptReady: vi.fn(),
  navigateToChatGPT: vi.fn(),
  readAssistantSnapshot: vi.fn(),
  readChatGptAccountDigest: vi.fn(),
}));
const providerFlowMocks = vi.hoisted(() => ({
  runProviderSubmissionFlow: vi.fn(),
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
vi.mock("../../src/browser/actions/deepResearch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof DeepResearch>()),
  ...deepResearchMocks,
}));
vi.mock("../../src/browser/pageActions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PageActions>()),
  ...pageActionMocks,
}));
vi.mock("../../src/browser/providerDomFlow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderDomFlow>()),
  ...providerFlowMocks,
}));
vi.mock("../../src/browser/profileState.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProfileState>()),
  ...profileStateMocks,
}));

import { runBrowserMode } from "../../src/browser/index.js";

describe("remote Deep Research completion affinity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    chromeMocks.closeTab.mockReset();
    chromeMocks.connectToRemoteChrome.mockReset();
    cookieMocks.clearStaleChatGptConversationCookies.mockReset();
    deepResearchMocks.activateDeepResearch.mockReset();
    deepResearchMocks.captureDeepResearchTargetKeys.mockReset();
    deepResearchMocks.waitForDeepResearchCompletion.mockReset();
    deepResearchMocks.waitForResearchPlanAutoConfirm.mockReset();
    pageActionMocks.clearPromptComposer.mockReset();
    pageActionMocks.ensureChatMode.mockReset();
    pageActionMocks.ensureLoggedIn.mockReset();
    pageActionMocks.ensureNotBlocked.mockReset();
    pageActionMocks.ensurePromptReady.mockReset();
    pageActionMocks.navigateToChatGPT.mockReset();
    pageActionMocks.readAssistantSnapshot.mockReset();
    pageActionMocks.readChatGptAccountDigest.mockReset();
    providerFlowMocks.runProviderSubmissionFlow.mockReset();
    profileStateMocks.resolveRemoteChromeBrowserIdentity.mockReset();
  });

  test("returns the learned remote Chrome affinity after Deep Research succeeds", async () => {
    const accountDigest = "a".repeat(64);
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const conversationUrl = "https://chatgpt.com/c/deep-research";
    const Runtime = {
      enable: vi.fn().mockResolvedValue({}),
      evaluate: vi.fn(async () => ({ result: { value: conversationUrl } })),
    };
    const client = {
      DOM: undefined,
      Emulation: { setFocusEmulationEnabled: vi.fn().mockResolvedValue({}) },
      Input: {},
      Network: { enable: vi.fn().mockResolvedValue({}) },
      Page: { enable: vi.fn().mockResolvedValue({}) },
      Runtime,
      Target: {},
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };

    vi.stubEnv("ORACLE_WRAPPER_REMOTE_ONLY", "0");
    profileStateMocks.resolveRemoteChromeBrowserIdentity.mockResolvedValue({
      browserId: "browser-a",
      browserWSEndpoint,
    });
    chromeMocks.connectToRemoteChrome.mockResolvedValue({
      client,
      targetId: "remote-target",
      close: vi.fn().mockResolvedValue(undefined),
    });
    chromeMocks.closeTab.mockResolvedValue(true);
    cookieMocks.clearStaleChatGptConversationCookies.mockResolvedValue(0);
    deepResearchMocks.activateDeepResearch.mockResolvedValue(undefined);
    deepResearchMocks.captureDeepResearchTargetKeys.mockResolvedValue([]);
    deepResearchMocks.waitForResearchPlanAutoConfirm.mockResolvedValue(undefined);
    deepResearchMocks.waitForDeepResearchCompletion.mockResolvedValue({
      text: "Completed deep research report.",
      html: "<p>Completed deep research report.</p>",
    });
    pageActionMocks.clearPromptComposer.mockResolvedValue(undefined);
    pageActionMocks.ensureChatMode.mockResolvedValue("chat");
    pageActionMocks.ensureLoggedIn.mockResolvedValue(undefined);
    pageActionMocks.ensureNotBlocked.mockResolvedValue(undefined);
    pageActionMocks.ensurePromptReady.mockResolvedValue(undefined);
    pageActionMocks.navigateToChatGPT.mockResolvedValue(undefined);
    pageActionMocks.readAssistantSnapshot.mockResolvedValue(null);
    pageActionMocks.readChatGptAccountDigest.mockResolvedValue(accountDigest);
    providerFlowMocks.runProviderSubmissionFlow.mockImplementation(
      async (_provider: unknown, context: { state?: Record<string, unknown> }) => {
        if (!context.state) return;
        context.state.baselineTurns = 0;
        context.state.committedConversationUrl = conversationUrl;
        await (context.state.onPromptSubmitted as (() => Promise<void>) | undefined)?.();
      },
    );

    await expect(
      runBrowserMode({
        prompt: "Research this topic",
        config: {
          archiveConversations: "never",
          modelStrategy: "ignore",
          remoteChrome: { host: "127.0.0.1", port: 9223 },
          remoteChromeBrowserWSEndpoint: browserWSEndpoint,
          researchMode: "deep",
        },
      }),
    ).resolves.toMatchObject({
      chatGptAccountDigest: accountDigest,
      chromeBrowserWSEndpoint: browserWSEndpoint,
    });
  });
});
