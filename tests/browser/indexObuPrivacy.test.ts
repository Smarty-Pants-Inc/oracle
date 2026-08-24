import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireOpenBrowserUseRunLock: vi.fn(),
  connectOpenBrowserUseTab: vi.fn(),
  prepareOpenBrowserUseChatGptRoute: vi.fn(),
  prepareOpenBrowserUseConversationRoute: vi.fn(),
  registerOpenBrowserUseTerminationHooks: vi.fn(),
  installJavaScriptDialogAutoDismissal: vi.fn(),
}));

vi.mock("../../src/browser/openBrowserUse.ts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    acquireOpenBrowserUseRunLock: mocks.acquireOpenBrowserUseRunLock,
    connectOpenBrowserUseTab: mocks.connectOpenBrowserUseTab,
    prepareOpenBrowserUseChatGptRoute: mocks.prepareOpenBrowserUseChatGptRoute,
    prepareOpenBrowserUseConversationRoute: mocks.prepareOpenBrowserUseConversationRoute,
    registerOpenBrowserUseTerminationHooks: mocks.registerOpenBrowserUseTerminationHooks,
  };
});

vi.mock("../../src/browser/pageActions.ts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    installJavaScriptDialogAutoDismissal: mocks.installJavaScriptDialogAutoDismissal,
  };
});

import { runBrowserMode } from "../../src/browser/index.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

const signedAttachedUrl =
  "https://chatgpt.com/c/unverified?signature=attached-secret&expires=9999999999#private";
const approvedResumeUrl = "https://chatgpt.com/c/verified-thread";
const routeConfig = {
  browserTransport: "obu" as const,
  obuSessionId: "oracle-main",
  obuTabId: 7,
  chatGptAccountEmail: "paul@smartypants.ai",
  chatGptWorkspaceName: "Paul Bettner",
  chatGptAccountDigest: "a".repeat(64),
  chatGptWorkspaceDigest: "b".repeat(64),
};

function fakeChromeClient() {
  return {
    on: vi.fn(),
    Network: { enable: vi.fn().mockResolvedValue(undefined) },
    Page: { enable: vi.fn().mockResolvedValue(undefined) },
    Runtime: { enable: vi.fn().mockResolvedValue(undefined) },
    Input: {},
    DOM: { enable: vi.fn().mockResolvedValue(undefined) },
    Target: {},
    Emulation: { setFocusEmulationEnabled: vi.fn().mockResolvedValue(undefined) },
  };
}

async function runUntilRouteDisconnect(resumeConversationUrl?: string) {
  const routeError = new BrowserAutomationError(
    "WebSocket connection closed during main-Chrome route verification.",
    {
      stage: "main-chrome-account-router",
      code: "account-route-disconnected",
      actualUrl: signedAttachedUrl,
    },
  );
  const routeMock = resumeConversationUrl
    ? mocks.prepareOpenBrowserUseConversationRoute
    : mocks.prepareOpenBrowserUseChatGptRoute;
  routeMock.mockRejectedValueOnce(routeError);

  return runBrowserMode({
    prompt: "must not send",
    sessionId: "oracle-session",
    config: { ...routeConfig, resumeConversationUrl },
  }).then(
    () => null,
    (error: unknown) => error,
  );
}

describe("main-Chrome pre-affinity recovery metadata", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.acquireOpenBrowserUseRunLock.mockResolvedValue({
      path: "/tmp/oracle.lock",
      lockId: "lock-1",
      release: vi.fn(async () => undefined),
    });
    mocks.registerOpenBrowserUseTerminationHooks.mockReturnValue(
      Object.assign(vi.fn(), {
        waitForDrain: vi.fn(async () => undefined),
        isTerminating: vi.fn(() => false),
        isLockUncertain: vi.fn(() => false),
      }),
    );
    mocks.installJavaScriptDialogAutoDismissal.mockReturnValue(vi.fn());
    mocks.connectOpenBrowserUseTab.mockImplementation(async () => ({
      client: fakeChromeClient(),
      obuClient: {},
      sessionId: "oracle-main",
      tabId: 7,
      tabUrl: signedAttachedUrl,
      created: false,
      finalize: vi.fn(async () => undefined),
    }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("ignores the unverified attached URL but retains an approved resume URL", async () => {
    const freshRunError = await runUntilRouteDisconnect();
    expect(freshRunError).toBeInstanceOf(BrowserAutomationError);
    const freshRuntime = (freshRunError as BrowserAutomationError).details?.runtime as
      | Record<string, unknown>
      | undefined;
    expect(freshRuntime).toMatchObject({
      browserTransport: "obu",
      obuSessionId: "oracle-main",
      obuTabId: 7,
    });
    expect(freshRuntime?.tabUrl).toBeUndefined();
    expect(JSON.stringify(freshRuntime)).not.toContain(signedAttachedUrl);
    expect(JSON.stringify(freshRuntime)).not.toContain("attached-secret");

    const resumedRunError = await runUntilRouteDisconnect(approvedResumeUrl);
    expect(resumedRunError).toBeInstanceOf(BrowserAutomationError);
    const resumedRuntime = (resumedRunError as BrowserAutomationError).details?.runtime as
      | Record<string, unknown>
      | undefined;
    expect(resumedRuntime?.tabUrl).toBe(approvedResumeUrl);
    expect(JSON.stringify(resumedRuntime)).not.toContain(signedAttachedUrl);
    expect(mocks.connectOpenBrowserUseTab.mock.calls[0]?.[0]).toMatchObject({
      conversationUrl: null,
    });
    expect(mocks.connectOpenBrowserUseTab.mock.calls[1]?.[0]).toMatchObject({
      conversationUrl: approvedResumeUrl,
    });
  });
});
