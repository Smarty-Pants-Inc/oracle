import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  resumeBrowserSession,
  retryBrowserRecoveryCleanup,
  __test__,
} from "../../src/browser/reattach.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";
import type { ChromeProcessIdentity } from "../../src/browser/profileState.js";
import type { RemoteRecoverySettlementOptions } from "../../src/remote/types.js";

function chromeProcessIdentity(userDataDir: string, pid?: number): ChromeProcessIdentity {
  const resolvedUserDataDir = path.resolve(userDataDir);
  const existsLocally = existsSync(resolvedUserDataDir);
  const canonicalPath = existsLocally ? realpathSync(resolvedUserDataDir) : resolvedUserDataDir;
  const physical = existsLocally ? statSync(canonicalPath, { bigint: true }) : null;
  return {
    pid: pid ?? 1234,
    processStartTime: "test-process-generation",
    executablePath:
      process.platform === "win32"
        ? String.raw`c:\program files\google\chrome\application\chrome.exe`
        : process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : "/usr/bin/google-chrome",
    normalizedUserDataDir:
      process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath,
    launchNonce: "11111111-1111-4111-8111-111111111111",
    profileDirectory: {
      version: 1,
      platform: process.platform,
      canonicalPath,
      device: physical?.dev.toString() ?? "1",
      inode: physical?.ino.toString() ?? "1",
    },
  };
}

type FakeTarget = { id?: string; targetId?: string; type?: string; url?: string };
type FakeClient = {
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Runtime: {
    enable: () => void;
    evaluate: (params: {
      expression: string;
      returnByValue?: boolean;
    }) => Promise<{ result: { value: unknown } }>;
  };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  DOM: { enable: () => void };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Page?: { enable: () => void };
  close: () => Promise<void> | void;
};
function withCommittedPromptEpoch(
  runtime: BrowserRuntimeMetadata = {},
  verifiedUserTurnIndex = 1,
): BrowserRuntimeMetadata {
  const conversationId =
    runtime.conversationId ?? runtime.tabUrl?.match(/\/c\/([^/?#]+)/u)?.[1] ?? "test-conversation";
  const processIdentity =
    runtime.chromeProcessIdentity ??
    (runtime.recoveryCleanup?.transport === "local" && runtime.userDataDir
      ? chromeProcessIdentity(runtime.userDataDir, runtime.chromePid)
      : undefined);
  return {
    ...runtime,
    ...(processIdentity ? { chromeProcessIdentity: processIdentity } : {}),
    conversationId,
    promptEpoch: {
      status: "committed",
      epochId: `epoch-${conversationId}`,
      promptSha256: "a".repeat(64),
      baselineTurns: 0,
      followUpOrdinal: 0,
      remainingFollowUps: 0,
      verifiedUserTurnIndex,
      conversationId,
    },
  };
}

describe("resumeBrowserSession", () => {
  test("selects target and captures markdown via stubs", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-profile-"));
    const runtime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      userDataDir: profileDir,
      tabUrl: "https://chatgpt.com/c/abc",
      recoveryCleanup: {
        transport: "local",
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
      },
    });
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const cleanupOrder: string[] = [];
    const close = vi.fn(async () => {
      cleanupOrder.push("connection");
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "Hello PATH plan",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "markdown response");
    const waitForConversationHydration = vi.fn(async () => 2);
    const closeChromeTarget = vi.fn(async () => {
      cleanupOrder.push("target");
      return true;
    });
    const terminateRecordedChromeForProfile = vi.fn(async () => {
      cleanupOrder.push("terminate");
      return { status: "stopped", pid: 1234, signal: "SIGTERM" } as const;
    });
    const removeProfile = vi.fn(async () => {
      cleanupOrder.push("remove-profile");
      return true;
    });
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
      waitForConversationHydration,
      recoveryCleanup: { closeChromeTarget, terminateRecordedChromeForProfile, removeProfile },
    });

    expect(result.answerMarkdown).toBe("markdown response");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 51559, target: "target-1" }),
    );
    expect(waitForAssistantResponse).toHaveBeenCalled();
    expect(captureAssistantMarkdown).toHaveBeenCalled();
    expect(waitForConversationHydration).toHaveBeenCalledWith(expect.anything(), 2000, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl: runtime.tabUrl,
    });
    expect(waitForConversationHydration.mock.invocationCallOrder[0]).toBeLessThan(
      waitForAssistantResponse.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(close).toHaveBeenCalledOnce();
    expect(cleanupOrder).toEqual(["connection"]);
    const finalization = await result.finalize();
    expect(finalization.status).toBe("completed");
    expect(cleanupOrder).toEqual(["connection", "target", "terminate", "remove-profile"]);
    expect(closeChromeTarget).toHaveBeenCalledWith(
      expect.objectContaining({ port: 51559, targetId: "target-1" }),
    );
    expect(terminateRecordedChromeForProfile).toHaveBeenCalledWith(
      profileDir,
      runtime.chromeProcessIdentity,
      logger,
    );
    expect(removeProfile).toHaveBeenCalledWith(profileDir);
    await rm(profileDir, { recursive: true, force: true });
  });

  test("uses the committed prompt epoch as the assistant turn floor", async () => {
    const runtime = withCommittedPromptEpoch(
      {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
      },
      2,
    );
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "live reattach pro 123",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-4" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "live reattach pro 123");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
      waitForConversationHydration: vi.fn(async () => 2),
      promptPreview: "stale serialized prompt preview",
    });
    await result.abandon();

    expect(waitForAssistantResponse).toHaveBeenCalledWith(expect.anything(), 2000, logger, 3);
  });

  test("rejects unauthorized or incomplete prompt epochs", async () => {
    const unauthorizedRuntimes: BrowserRuntimeMetadata[] = [
      {
        chromePort: 51559,
        tabUrl: "https://chatgpt.com/c/abc",
      },
      {
        chromePort: 51559,
        tabUrl: "https://chatgpt.com/c/abc",
        promptEpoch: {
          status: "pending",
          epochId: "follow-up-pending",
          promptSha256: "pending-prompt-sha256",
          baselineTurns: 4,
          followUpOrdinal: 1,
          remainingFollowUps: 0,
        },
      },
      {
        chromePort: 51559,
        conversationId: "abc",
        tabUrl: "https://chatgpt.com/c/abc",
        promptEpoch: {
          status: "committed",
          epochId: "wrong-conversation",
          promptSha256: "wrong-conversation-sha256",
          baselineTurns: 4,
          followUpOrdinal: 0,
          remainingFollowUps: 0,
          verifiedUserTurnIndex: 4,
          conversationId: "different-conversation",
        },
      },
      {
        chromePort: 51559,
        conversationId: "abc",
        tabUrl: "https://example.com/c/abc",
        promptEpoch: {
          status: "committed",
          epochId: "hostile-stored-url",
          promptSha256: "f".repeat(64),
          baselineTurns: 4,
          followUpOrdinal: 0,
          remainingFollowUps: 0,
          verifiedUserTurnIndex: 4,
          conversationId: "abc",
        },
      },
      {
        chromePort: 51559,
        conversationId: "abc",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
        promptEpoch: {
          status: "committed",
          epochId: "follow-ups-remain",
          promptSha256: "current-prompt-sha256",
          baselineTurns: 4,
          followUpOrdinal: 0,
          remainingFollowUps: 1,
          verifiedUserTurnIndex: 4,
          conversationId: "abc",
        },
      },
      {
        chromePort: 51559,
        conversationId: "abc",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
        promptEpoch: {
          status: "committed",
          epochId: " ",
          promptSha256: " ",
          baselineTurns: 5,
          followUpOrdinal: 0,
          remainingFollowUps: 0,
          verifiedUserTurnIndex: 4,
          conversationId: "abc",
        },
      },
    ];
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "prior prompt answer",
      html: "",
      meta: { messageId: "prior-answer", turnId: "conversation-turn-3" },
    }));

    for (const runtime of unauthorizedRuntimes) {
      await expect(
        resumeBrowserSession(runtime, {}, vi.fn() as BrowserLogger, {
          listTargets: vi.fn(async () => {
            throw new Error("prior assistant answer must not be captured");
          }),
          waitForAssistantResponse,
        }),
      ).rejects.toThrow(/prompt epoch|conversation|follow-up/i);
    }
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
  });

  test("uses Deep Research completion path when reattaching research sessions", async () => {
    const runtime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/deep",
    });
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (expression.includes("querySelectorAll")) {
        return { result: { value: 3 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Page: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn();
    const captureAssistantMarkdown = vi.fn();
    const waitForDeepResearchCompletion = vi.fn(async () => ({
      text: "Deep report body",
      html: "<p>Deep report body</p>",
      meta: { turnId: null, messageId: null },
    }));
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(
      runtime,
      { timeoutMs: 2000, researchMode: "deep" },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        waitForDeepResearchCompletion,
        waitForConversationHydration: vi.fn(async () => 2),
      },
    );

    expect(result.answerMarkdown).toBe("Deep report body");
    expect(waitForDeepResearchCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ evaluate }),
      logger,
      2000,
      2,
      expect.any(Object),
      expect.any(Object),
      {
        requireScopedTargetOwner: true,
      },
    );
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    await result.abandon();
    expect(captureAssistantMarkdown).not.toHaveBeenCalled();
  });

  test("falls back to recovery when chrome port is missing", async () => {
    const runtime = withCommittedPromptEpoch({
      tabUrl: "https://chatgpt.com/c/abc",
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, { recoverSession });

    expect(result.answerMarkdown).toBe("fallback-md");
    expect(recoverSession).toHaveBeenCalled();
    await result.abandon();
  });

  test("tries live reattach from browser websocket metadata before falling back", async () => {
    const runtime = withCommittedPromptEpoch({
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeProfileRoot: path.join(os.tmpdir(), "oracle-attach-running-profile"),
      tabUrl: "https://chatgpt.com/c/abc",
      chromeTargetId: "target-2",
    });
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-2", type: "page", url: "https://chatgpt.com/c/abc" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "attached-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { attachRunning: true, timeoutMs: 2_000 },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        waitForConversationHydration: vi.fn(async () => 2),
      },
    );

    expect(result.answerMarkdown).toBe("attached-md");
    expect(listTargets).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "ws://127.0.0.1:9222/devtools/browser/abc",
        local: true,
      }),
    );
    await result.abandon();
  });

  test("closes the attached client before falling back to recovery", async () => {
    const runtime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    });
    const listTargets = vi.fn(async () => {
      return [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[];
    }) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "must not be captured from an unhydrated shell",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const waitForConversationHydration = vi.fn(async () => {
      throw new Error("saved conversation did not hydrate");
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      waitForConversationHydration,
      recoverSession,
    });

    expect(result.answerText).toBe("fallback");
    expect(close).toHaveBeenCalledOnce();
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(recoverSession).toHaveBeenCalled();
    await result.abandon();
  });
  test("fails closed when the original target is missing among unrelated user tabs", async () => {
    const profileRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-refresh-"));
    const refreshedPort = 63332;
    const refreshedEndpoint = `ws://127.0.0.1:${refreshedPort}/devtools/browser/refreshed`;
    const fallbackProfileRoot = path.join(profileRoot, "fallback-profile");
    await writeFile(
      path.join(profileRoot, "DevToolsActivePort"),
      `${refreshedPort}\n/devtools/browser/refreshed\n`,
      "utf8",
    );

    try {
      const runtime = withCommittedPromptEpoch({
        chromePort: 41111,
        chromeHost: "127.0.0.1",
        chromeBrowserWSEndpoint: "ws://127.0.0.1:41111/devtools/browser/stale",
        chromeProfileRoot: profileRoot,
        chromeTargetId: "missing-original-target",
        tabUrl: "https://chatgpt.com/c/abc",
        recoveryCleanup: {
          transport: "local",
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: false,
        },
      });
      const listTargets = vi.fn(async () => [
        { targetId: "unrelated-target", type: "page", url: "https://chatgpt.com/c/unrelated" },
        { targetId: "same-conversation-user-tab", type: "page", url: runtime.tabUrl },
      ]) as unknown as () => Promise<FakeTarget[]>;
      const connect = vi.fn(async () => {
        throw new Error("must not attach to a user-owned target");
      }) as unknown as (options?: unknown) => Promise<ChromeClient>;
      const waitForConversationHydration = vi.fn(async () => 2);
      const recoverSession = vi.fn(async (authoritativeRuntime: BrowserRuntimeMetadata) => ({
        answerText: "fallback",
        answerMarkdown: "fallback-md",
        runtime: {
          ...authoritativeRuntime,
          chromePid: 4242,
          chromePort: 64443,
          chromeBrowserWSEndpoint: undefined,
          chromeProfileRoot: fallbackProfileRoot,
          userDataDir: fallbackProfileRoot,
          chromeTargetId: undefined,
          recoveryCleanup: {
            transport: "remote" as const,
            ownsTarget: false,
            profileKind: "none" as const,
            keepBrowser: true,
          },
          recoveryCleanupBacklog: __test__.buildRecoveryCleanupBacklog(authoritativeRuntime),
        },
      }));
      const closeChromeTarget = vi.fn(async () => true);

      const result = await resumeBrowserSession(runtime, {}, vi.fn() as BrowserLogger, {
        listTargets,
        connect,
        waitForConversationHydration,
        recoverSession,
        recoveryCleanup: { closeChromeTarget },
      });

      expect(result.answerMarkdown).toBe("fallback-md");
      expect(connect).not.toHaveBeenCalled();
      expect(waitForConversationHydration).not.toHaveBeenCalled();
      expect(recoverSession).toHaveBeenCalledWith(
        expect.objectContaining({
          chromePort: refreshedPort,
          chromeBrowserWSEndpoint: refreshedEndpoint,
          chromeTargetId: undefined,
        }),
        {},
      );
      expect(result.runtime.recoveryCleanupBacklog).toEqual([
        expect.objectContaining({
          chromePort: refreshedPort,
          chromeBrowserWSEndpoint: refreshedEndpoint,
          chromeTargetId: undefined,
        }),
      ]);

      const finalized = await result.finalize();
      expect(finalized).toMatchObject({
        status: "pending",
        error: expect.stringContaining("Owned Chrome target cleanup metadata is incomplete"),
      });
      expect(closeChromeTarget).not.toHaveBeenCalled();
    } finally {
      await rm(profileRoot, { recursive: true, force: true });
    }
  });

  test("allows an explicit browser tab reference without claiming ownership", async () => {
    const runtime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "missing-original-target",
      tabUrl: "https://chatgpt.com/c/abc",
      recoveryCleanup: {
        transport: "local",
        ownsTarget: true,
        profileKind: "none",
        keepBrowser: false,
      },
    });
    const listTargets = vi.fn(async () => [
      { targetId: "borrowed-target", type: "page", url: runtime.tabUrl },
    ]) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
      result: { value: expression === "location.href" ? runtime.tabUrl : 2 },
    }));
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => undefined),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const closeChromeTarget = vi.fn(async () => true);

    const result = await resumeBrowserSession(
      runtime,
      { browserTabRef: "borrowed-target", timeoutMs: 2_000 },
      vi.fn() as BrowserLogger,
      {
        listTargets,
        connect,
        waitForConversationHydration: vi.fn(async () => 2),
        waitForAssistantResponse: vi.fn(async () => ({
          text: "borrowed capture",
          html: "",
          meta: { messageId: "m1", turnId: "conversation-turn-3" },
        })),
        captureAssistantMarkdown: vi.fn(async () => "borrowed capture"),
        recoveryCleanup: { closeChromeTarget },
      },
    );

    expect(result.runtime).toMatchObject({
      chromeTargetId: "borrowed-target",
      recoveryCleanup: { ownsTarget: false },
    });
    expect((await result.finalize()).status).toBe("completed");
    expect(closeChromeTarget).not.toHaveBeenCalled();
  });
});

describe("recovery resource finalization", () => {
  const { finalizeRecoveredRuntime } = __test__;
  const stopped = { status: "stopped", pid: 1234, signal: "SIGTERM" } as const;

  test("serializes immutable Chrome process identity into cleanup backlog", () => {
    const profileDir = path.join(os.tmpdir(), "oracle-backlog-identity");
    const processIdentity = chromeProcessIdentity(profileDir, 4242);
    expect(
      __test__.buildRecoveryCleanupBacklog({
        chromePid: 4242,
        chromeProcessIdentity: processIdentity,
        userDataDir: profileDir,
        recoveryCleanup: {
          transport: "local",
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
      }),
    ).toEqual([
      expect.objectContaining({
        chromePid: 4242,
        chromeProcessIdentity: processIdentity,
        userDataDir: profileDir,
      }),
    ]);
  });

  test("derives the recovery lock from immutable prompt and process identity", () => {
    const profileDir = path.join(os.tmpdir(), "oracle-browser-lock-identity");
    const runtime = withCommittedPromptEpoch({
      chromeProcessIdentity: chromeProcessIdentity(profileDir),
      chromeProfileRoot: profileDir,
      userDataDir: profileDir,
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/old",
      chromeTargetId: "old-target",
    });

    expect(
      __test__.defaultRecoveryLockPath({
        ...runtime,
        chromeHost: "localhost",
        chromePort: 9333,
        chromeBrowserWSEndpoint: "ws://localhost:9333/devtools/browser/new",
        chromeTargetId: "new-target",
      }),
    ).toBe(__test__.defaultRecoveryLockPath(runtime));
  });

  test("treats an already-absent contained temporary profile as complete", async () => {
    const profileDir = path.join(os.tmpdir(), "oracle-browser-already-absent-cleanup");
    await rm(profileDir, { recursive: true, force: true });
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const removeProfile = vi.fn(async () => true);

    const result = await finalizeRecoveredRuntime(
      {
        userDataDir: profileDir,
        recoveryCleanup: {
          transport: "local",
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
      },
      vi.fn() as BrowserLogger,
      { terminateRecordedChromeForProfile, removeProfile },
    );

    expect(result.status).toBe("completed");
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
  });

  test("retains local cleanup authority when process identity is missing", async () => {
    const profileDir = await mkdtemp(
      path.join(os.tmpdir(), "oracle-browser-missing-process-identity-"),
    );
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    try {
      const result = await finalizeRecoveredRuntime(
        {
          userDataDir: profileDir,
          recoveryCleanup: {
            transport: "local",
            ownsTarget: false,
            profileKind: "temporary",
            keepBrowser: false,
          },
        },
        vi.fn() as BrowserLogger,
        { terminateRecordedChromeForProfile },
      );

      expect(result).toMatchObject({
        status: "pending",
        error: expect.stringContaining("Chrome process identity cleanup metadata is missing"),
      });
      expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("preserves cleanup when persisted process identity lacks physical profile authority", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-legacy-identity-"));
    const legacyIdentity = {
      pid: 1234,
      processStartTime: "legacy-process-generation",
      executablePath: "/usr/bin/google-chrome",
      normalizedUserDataDir: profileDir,
      launchNonce: "22222222-2222-4222-8222-222222222222",
    } as unknown as ChromeProcessIdentity;
    const runtime: BrowserRuntimeMetadata = {
      chromeProcessIdentity: legacyIdentity,
      userDataDir: profileDir,
      recoveryCleanup: {
        transport: "local",
        ownsTarget: false,
        profileKind: "temporary",
        keepBrowser: false,
      },
    };
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    try {
      expect(() => __test__.defaultRecoveryLockPath(runtime)).not.toThrow();
      expect(() =>
        __test__.recoveryCleanupGroupKey({
          chromeProcessIdentity: legacyIdentity,
          userDataDir: profileDir,
          recoveryCleanup: runtime.recoveryCleanup!,
        }),
      ).not.toThrow();

      const result = await finalizeRecoveredRuntime(runtime, vi.fn() as BrowserLogger, {
        terminateRecordedChromeForProfile,
      });

      expect(result).toMatchObject({
        status: "pending",
        error: expect.stringContaining("physical profile identity cleanup metadata is missing"),
      });
      expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("does not enter manual lease teardown without physical profile authority", async () => {
    const profileDir = path.join(os.homedir(), ".oracle", "browser-profile");
    const legacyIdentity = {
      pid: 1234,
      processStartTime: "legacy-process-generation",
      executablePath: "/usr/bin/google-chrome",
      normalizedUserDataDir: profileDir,
      launchNonce: "33333333-3333-4333-8333-333333333333",
    } as unknown as ChromeProcessIdentity;
    const teardownBrowserResourcesIfNoActiveLeases = vi.fn(async () => ({
      status: "completed" as const,
    }));

    const result = await finalizeRecoveredRuntime(
      {
        chromeProcessIdentity: legacyIdentity,
        userDataDir: profileDir,
        recoveryCleanup: {
          transport: "local",
          ownsTarget: false,
          profileKind: "manual-login",
          keepBrowser: false,
        },
      },
      vi.fn() as BrowserLogger,
      { teardownBrowserResourcesIfNoActiveLeases },
    );

    expect(result).toMatchObject({
      status: "pending",
      error: expect.stringContaining("physical profile identity cleanup metadata is missing"),
    });
    expect(teardownBrowserResourcesIfNoActiveLeases).not.toHaveBeenCalled();
  });

  test("defers cleanup until finalize and runs the finalizer once", async () => {
    const events: string[] = [];
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-fallback-profile-"));
    const runtime = withCommittedPromptEpoch({
      chromePort: 9222,
      chromeTargetId: "original-target",
      userDataDir: profileDir,
      recoveryCleanup: {
        transport: "local",
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
      },
    });
    const logger = vi.fn() as BrowserLogger;
    const result = await resumeBrowserSession(runtime, {}, logger, {
      recoverSession: vi.fn(async () => {
        events.push("fallback-capture");
        return { answerText: "fallback", answerMarkdown: "fallback" };
      }),
      recoveryCleanup: {
        closeChromeTarget: vi.fn(async () => {
          events.push("close-target");
          return true;
        }),
        terminateRecordedChromeForProfile: vi.fn(async () => {
          events.push("terminate");
          return stopped;
        }),
        removeProfile: vi.fn(async () => {
          events.push("remove-profile");
          await rm(profileDir, { recursive: true, force: true });
          return true;
        }),
      },
    });

    expect(events).toEqual(["fallback-capture"]);
    expect(result.runtime.recoveryCleanupResult).toEqual({ status: "pending" });
    const first = await result.finalize();
    const second = await result.finalize();
    expect(first.status).toBe("completed");
    expect(second).toBe(first);
    expect(events).toEqual(["fallback-capture", "close-target", "terminate", "remove-profile"]);
  });

  test("abandon releases authority without running cleanup", async () => {
    const finalizeResources = vi.fn(async () => ({
      status: "completed" as const,
      runtime: {},
    }));
    const abandonResources = vi.fn(async () => undefined);
    const result = await resumeBrowserSession(
      withCommittedPromptEpoch(),
      {},
      vi.fn() as BrowserLogger,
      {
        recoverSession: vi.fn(async () => ({
          answerText: "captured",
          answerMarkdown: "captured",
          finalizeResources,
          abandonResources,
        })),
      },
    );

    await result.abandon();
    expect(abandonResources).toHaveBeenCalledOnce();
    expect(finalizeResources).not.toHaveBeenCalled();
  });

  test("retains cleanup authority when Chrome termination is unsafe", async () => {
    const removeProfile = vi.fn(async () => true);
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-unsafe-cleanup-"));
    try {
      const result = await finalizeRecoveredRuntime(
        {
          userDataDir: profileDir,
          chromeProcessIdentity: chromeProcessIdentity(profileDir),
          recoveryCleanup: {
            transport: "local",
            ownsTarget: false,
            profileKind: "copied",
            keepBrowser: false,
          },
        },
        vi.fn() as BrowserLogger,
        {
          terminateRecordedChromeForProfile: vi.fn(async () => ({
            status: "unsafe" as const,
            reason: "pid mismatch",
          })),
          removeProfile,
        },
      );

      expect(result).toMatchObject({
        status: "pending",
        runtime: {
          recoveryCleanup: { profileKind: "copied" },
          recoveryCleanupResult: {
            status: "failed",
            error: expect.stringContaining("pid mismatch"),
          },
        },
      });
      expect(removeProfile).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("closes every shared-process target before one teardown", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-shared-group-"));
    const processIdentity = chromeProcessIdentity(profileDir);
    const events: string[] = [];
    const oldResource = {
      chromeProcessIdentity: processIdentity,
      chromePort: 9111,
      userDataDir: profileDir,
      chromeTargetId: "old-target",
      recoveryCleanup: {
        transport: "local" as const,
        ownsTarget: true,
        profileKind: "temporary" as const,
        keepBrowser: false,
      },
    };
    try {
      const result = await finalizeRecoveredRuntime(
        {
          chromeProcessIdentity: processIdentity,
          chromePort: 9222,
          userDataDir: profileDir,
          chromeTargetId: "current-target",
          recoveryCleanup: {
            transport: "local",
            ownsTarget: true,
            profileKind: "temporary",
            keepBrowser: false,
          },
          recoveryCleanupBacklog: [oldResource, { ...oldResource }],
        },
        vi.fn() as BrowserLogger,
        {
          closeChromeTarget: vi.fn(async ({ targetId, port }) => {
            events.push(`close:${targetId}:${port}`);
            return true;
          }),
          terminateRecordedChromeForProfile: vi.fn(async () => {
            events.push("terminate");
            return stopped;
          }),
          removeProfile: vi.fn(async () => {
            events.push("remove-profile");
            return true;
          }),
        },
      );

      expect(result.status).toBe("completed");
      expect(events).toEqual([
        "close:old-target:9222",
        "close:current-target:9222",
        "terminate",
        "remove-profile",
      ]);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });
  test("holds the current lease through shared target close and atomic manual teardown", async () => {
    const profileDir = path.join(os.homedir(), ".oracle", "browser-profile");
    const processIdentity = chromeProcessIdentity(profileDir, 5151);
    const events: string[] = [];
    const releaseCurrentLease = vi.fn(
      async (options?: { onRelease?: (context: { isLastLease: boolean }) => Promise<void> }) => {
        events.push("release-current-lease");
        await options?.onRelease?.({ isLastLease: true });
      },
    );
    const result = await finalizeRecoveredRuntime(
      {
        chromeProcessIdentity: processIdentity,
        chromePort: 9222,
        userDataDir: profileDir,
        chromeTargetId: "current-target",
        recoveryCleanup: {
          transport: "local",
          ownsTarget: true,
          profileKind: "manual-login",
          keepBrowser: false,
        },
        recoveryCleanupBacklog: [
          {
            chromeProcessIdentity: processIdentity,
            chromePort: 9222,
            userDataDir: profileDir,
            chromeTargetId: "old-target",
            recoveryCleanup: {
              transport: "local",
              ownsTarget: true,
              profileKind: "manual-login",
              keepBrowser: false,
            },
          },
        ],
      },
      vi.fn() as BrowserLogger,
      {
        closeChromeTarget: vi.fn(async ({ targetId }) => {
          events.push(`close:${targetId}`);
          return true;
        }),
        terminateRecordedChromeForProfile: vi.fn(async () => {
          events.push("terminate");
          return stopped;
        }),
        cleanupStaleProfileState: vi.fn(async () => {
          events.push("cleanup-profile-state");
          return true;
        }),
      },
      releaseCurrentLease,
    );

    expect(result.status).toBe("completed");
    expect(events).toEqual([
      "close:old-target",
      "close:current-target",
      "release-current-lease",
      "terminate",
      "cleanup-profile-state",
    ]);
    expect(releaseCurrentLease).toHaveBeenCalledOnce();
  });

  test("does not let a permanently failing old group block current cleanup", async () => {
    const oldProfile = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-old-group-"));
    const currentProfile = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-current-group-"));
    const events: string[] = [];
    try {
      const result = await finalizeRecoveredRuntime(
        {
          chromeProcessIdentity: chromeProcessIdentity(currentProfile, 2222),
          chromePort: 9333,
          userDataDir: currentProfile,
          chromeTargetId: "current-target",
          recoveryCleanup: {
            transport: "local",
            ownsTarget: true,
            profileKind: "temporary",
            keepBrowser: false,
          },
          recoveryCleanupBacklog: [
            {
              chromeProcessIdentity: chromeProcessIdentity(oldProfile, 1111),
              chromePort: 9222,
              userDataDir: oldProfile,
              chromeTargetId: "old-target",
              recoveryCleanup: {
                transport: "local",
                ownsTarget: true,
                profileKind: "temporary",
                keepBrowser: false,
              },
            },
          ],
        },
        vi.fn() as BrowserLogger,
        {
          closeChromeTarget: vi.fn(async ({ targetId }) => {
            events.push(`close:${targetId}`);
            return targetId !== "old-target";
          }),
          terminateRecordedChromeForProfile: vi.fn(async (profileDir) => {
            events.push(`terminate:${profileDir}`);
            return stopped;
          }),
          removeProfile: vi.fn(async (profileDir) => {
            events.push(`remove:${profileDir}`);
            return true;
          }),
        },
      );

      expect(result.status).toBe("pending");
      expect(events).toEqual([
        "close:old-target",
        "close:current-target",
        `terminate:${currentProfile}`,
        `remove:${currentProfile}`,
      ]);
      expect(result.runtime.recoveryCleanup).toBeUndefined();
      expect(result.runtime.recoveryCleanupBacklog).toEqual([
        expect.objectContaining({ chromeTargetId: "old-target" }),
      ]);
    } finally {
      await rm(oldProfile, { recursive: true, force: true });
      await rm(currentProfile, { recursive: true, force: true });
    }
  });

  test("retries only resources that failed the previous cleanup pass", async () => {
    const oldProfile = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-retry-old-group-"));
    const currentProfile = await mkdtemp(
      path.join(os.tmpdir(), "oracle-browser-retry-current-group-"),
    );
    const events: string[] = [];
    let oldAttempts = 0;
    const cleanupDeps = {
      closeChromeTarget: vi.fn(async ({ targetId }: { targetId: string }) => {
        events.push(`close:${targetId}`);
        if (targetId !== "old-target") return true;
        oldAttempts += 1;
        return oldAttempts > 1;
      }),
      terminateRecordedChromeForProfile: vi.fn(async (profileDir: string) => {
        events.push(`terminate:${profileDir}`);
        return stopped;
      }),
      removeProfile: vi.fn(async (profileDir: string) => {
        events.push(`remove:${profileDir}`);
        return true;
      }),
    };
    try {
      const first = await finalizeRecoveredRuntime(
        {
          chromeProcessIdentity: chromeProcessIdentity(currentProfile, 4444),
          chromePort: 9444,
          userDataDir: currentProfile,
          chromeTargetId: "current-target",
          recoveryCleanup: {
            transport: "local",
            ownsTarget: true,
            profileKind: "temporary",
            keepBrowser: false,
          },
          recoveryCleanupBacklog: [
            {
              chromeProcessIdentity: chromeProcessIdentity(oldProfile, 3333),
              chromePort: 9333,
              userDataDir: oldProfile,
              chromeTargetId: "old-target",
              recoveryCleanup: {
                transport: "local",
                ownsTarget: true,
                profileKind: "temporary",
                keepBrowser: false,
              },
            },
          ],
        },
        vi.fn() as BrowserLogger,
        cleanupDeps,
      );

      expect(first.status).toBe("pending");
      expect(first.runtime.recoveryCleanup).toBeUndefined();
      expect(first.runtime.recoveryCleanupBacklog).toHaveLength(1);
      const second = await finalizeRecoveredRuntime(
        first.runtime,
        vi.fn() as BrowserLogger,
        cleanupDeps,
      );

      expect(second.status).toBe("completed");
      expect(events).toEqual([
        "close:old-target",
        "close:current-target",
        `terminate:${currentProfile}`,
        `remove:${currentProfile}`,
        "close:old-target",
        `terminate:${oldProfile}`,
        `remove:${oldProfile}`,
      ]);
    } finally {
      await rm(oldProfile, { recursive: true, force: true });
      await rm(currentProfile, { recursive: true, force: true });
    }
  });

  test("settles remote cleanup once without direct host Chrome operations", async () => {
    const remoteRecovery = {
      protocolVersion: 2,
      host: "remote.example.test:9443",
      transactionToken: "a".repeat(64),
      state: "pending" as const,
    };
    const runtime = withCommittedPromptEpoch({
      chromeHost: "remote.example.test",
      chromePort: 9222,
      chromeTargetId: "remote-owned-target",
      remoteRecovery,
      recoveryCleanup: {
        transport: "remote",
        ownsTarget: true,
        profileKind: "none",
        keepBrowser: false,
      },
    });
    const closeChromeTarget = vi.fn(async () => true);
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const settleRemoteBrowserRecovery = vi.fn(async () => ({
      status: "completed" as const,
      runtime: {},
    }));
    const resolveRemoteRecoveryConfig = vi.fn(async () => ({
      host: remoteRecovery.host,
      token: "configured-auth-secret",
    }));
    const result = await finalizeRecoveredRuntime(
      {
        ...runtime,
        recoveryCleanupBacklog: [
          {
            chromeHost: "stale-remote.example.test",
            chromePort: 9111,
            chromeTargetId: "borrowed-target",
            remoteRecovery,
            recoveryCleanup: {
              transport: "remote",
              ownsTarget: false,
              profileKind: "none",
              keepBrowser: false,
            },
          },
        ],
      },
      vi.fn() as BrowserLogger,
      {
        closeChromeTarget,
        terminateRecordedChromeForProfile,
        settleRemoteBrowserRecovery,
        resolveRemoteRecoveryConfig,
      },
    );

    expect(result.status).toBe("completed");
    expect(settleRemoteBrowserRecovery).toHaveBeenCalledOnce();
    expect(settleRemoteBrowserRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredHost: remoteRecovery.host,
        authToken: "configured-auth-secret",
        runtime: expect.objectContaining({ remoteRecovery }),
      }),
    );
    expect(resolveRemoteRecoveryConfig).toHaveBeenCalledOnce();
    expect(closeChromeTarget).not.toHaveBeenCalled();
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });

  test("retries retained cleanup authority under the recovery lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-retry-test-"));
    const profileDir = path.join(os.tmpdir(), "oracle-browser-retry-cleanup");
    try {
      const result = await retryBrowserRecoveryCleanup(
        {
          userDataDir: profileDir,
          chromeProcessIdentity: chromeProcessIdentity(profileDir),
          recoveryCleanup: {
            transport: "local",
            ownsTarget: false,
            profileKind: "temporary",
            keepBrowser: false,
          },
          recoveryCleanupResult: { status: "failed", error: "previous termination failure" },
        },
        vi.fn() as BrowserLogger,
        {
          recoveryLockPath: path.join(root, "browser-recovery.lock"),
          recoveryCleanup: {
            terminateRecordedChromeForProfile: vi.fn(async () => stopped),
            removeProfile: vi.fn(async () => true),
          },
        },
      );

      expect(result).toEqual({
        status: "completed",
        runtime: {
          userDataDir: profileDir,
          chromeProcessIdentity: chromeProcessIdentity(profileDir),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves manual-login resources while another lease is active", async () => {
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const cleanupStaleProfileState = vi.fn(async () => true);
    const result = await finalizeRecoveredRuntime(
      {
        userDataDir: path.join(os.homedir(), ".oracle", "browser-profile"),
        chromeProcessIdentity: chromeProcessIdentity(
          path.join(os.homedir(), ".oracle", "browser-profile"),
        ),
        recoveryCleanup: {
          transport: "local",
          ownsTarget: false,
          profileKind: "manual-login",
          keepBrowser: false,
        },
      },
      vi.fn() as BrowserLogger,
      {
        teardownBrowserResourcesIfNoActiveLeases: vi.fn(async () => ({
          status: "preserved" as const,
          reason: "active-leases" as const,
        })),
        terminateRecordedChromeForProfile,
        cleanupStaleProfileState,
      },
    );

    expect(result.status).toBe("pending");
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    expect(cleanupStaleProfileState).not.toHaveBeenCalled();
  });

  test("terminates and clears manual-login state inside atomic teardown", async () => {
    const events: string[] = [];
    const profileDir = path.join(os.homedir(), ".oracle", "browser-profile");
    const processIdentity = chromeProcessIdentity(profileDir);
    const cleanupStaleProfileState = vi.fn(async () => {
      events.push("cleanup-profile-state");
      return true;
    });
    const teardownBrowserResourcesIfNoActiveLeases = vi.fn(
      async (_dir: string, teardown: () => Promise<boolean>) =>
        (await teardown())
          ? { status: "completed" as const }
          : { status: "preserved" as const, reason: "teardown-unsafe" as const },
    );
    const result = await finalizeRecoveredRuntime(
      {
        userDataDir: profileDir,
        chromeProcessIdentity: processIdentity,
        recoveryCleanup: {
          transport: "local",
          ownsTarget: false,
          profileKind: "manual-login",
          keepBrowser: false,
        },
      },
      vi.fn() as BrowserLogger,
      {
        teardownBrowserResourcesIfNoActiveLeases,
        terminateRecordedChromeForProfile: vi.fn(async () => {
          events.push("terminate");
          return stopped;
        }),
        cleanupStaleProfileState,
      },
    );

    expect(result.status).toBe("completed");
    expect(events).toEqual(["terminate", "cleanup-profile-state"]);
    expect(cleanupStaleProfileState).toHaveBeenCalledWith(profileDir, expect.any(Function), {
      lockRemovalMode: "never",
      expectedProfileIdentity: processIdentity.profileDirectory,
    });
    expect(teardownBrowserResourcesIfNoActiveLeases).toHaveBeenCalledWith(
      profileDir,
      expect.any(Function),
      {
        logger: expect.any(Function),
        expectedProfileIdentity: processIdentity.profileDirectory,
      },
    );
  });

  test("keeps remote settlement retryable and idempotent without CDP fallback", async () => {
    const remoteRecovery = {
      protocolVersion: 2,
      host: "remote.example.test:9443",
      transactionToken: "b".repeat(64),
      state: "pending" as const,
    };
    const closeChromeTarget = vi.fn(async () => true);
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    let attempts = 0;
    const settleRemoteBrowserRecovery = vi.fn(
      async ({ runtime }: RemoteRecoverySettlementOptions) => {
        attempts += 1;
        if (attempts === 1) {
          return {
            status: "pending" as const,
            runtime: {
              ...runtime,
              remoteRecovery,
              recoveryCleanupResult: {
                status: "failed" as const,
                error: "remote finalize still pending",
              },
            },
            error: "remote finalize still pending",
          };
        }
        return { status: "completed" as const, runtime: {} };
      },
    );
    const resolveRemoteRecoveryConfig = vi.fn(async () => ({
      host: remoteRecovery.host,
      token: "configured-auth-secret",
    }));
    const deps = {
      closeChromeTarget,
      terminateRecordedChromeForProfile,
      settleRemoteBrowserRecovery,
      resolveRemoteRecoveryConfig,
    };
    const first = await finalizeRecoveredRuntime(
      {
        chromeHost: "remote.example.test",
        chromePort: 9222,
        chromeBrowserWSEndpoint: "wss://remote.example.test/devtools/browser/abc",
        chromeTargetId: "remote-owned-target",
        remoteRecovery,
        recoveryCleanup: {
          transport: "remote",
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: false,
        },
      },
      vi.fn() as BrowserLogger,
      deps,
    );

    expect(first).toMatchObject({
      status: "pending",
      runtime: {
        remoteRecovery,
        recoveryCleanup: { transport: "remote" },
      },
    });
    expect(JSON.stringify(first.runtime)).not.toContain("configured-auth-secret");
    const second = await finalizeRecoveredRuntime(first.runtime, vi.fn() as BrowserLogger, deps);
    expect(second.status).toBe("completed");
    expect(settleRemoteBrowserRecovery).toHaveBeenCalledTimes(2);
    expect(resolveRemoteRecoveryConfig).toHaveBeenCalledTimes(2);
    expect(closeChromeTarget).not.toHaveBeenCalled();
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });

  test("rejects serialized temporary profiles outside approved runtime roots", async () => {
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const result = await finalizeRecoveredRuntime(
      {
        userDataDir: path.join(os.homedir(), "Downloads", "oracle-browser-malicious"),
        recoveryCleanup: {
          transport: "local",
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
      },
      vi.fn() as BrowserLogger,
      { terminateRecordedChromeForProfile },
    );

    expect(result).toMatchObject({ status: "pending", error: expect.stringMatching(/outside/) });
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });

  test("rejects noncanonical temporary profile paths before termination", async () => {
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const profileDir = `${path.join(os.tmpdir(), "oracle-browser-parent")}${path.sep}..${path.sep}oracle-browser-traversal`;
    const result = await finalizeRecoveredRuntime(
      {
        userDataDir: profileDir,
        recoveryCleanup: {
          transport: "local",
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
      },
      vi.fn() as BrowserLogger,
      { terminateRecordedChromeForProfile },
    );

    expect(result).toMatchObject({ status: "pending", error: expect.stringMatching(/canonical/) });
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });

  test("serializes concurrent recovery for one session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-lock-test-"));
    const recoveryLockPath = path.join(root, "browser-recovery.lock");
    const logger = vi.fn() as BrowserLogger;
    const recoverSession = vi.fn(async () => ({ answerText: "ok", answerMarkdown: "ok" }));
    const runtime = withCommittedPromptEpoch();
    try {
      const first = await resumeBrowserSession(runtime, {}, logger, {
        recoverSession,
        recoveryLockPath,
      });
      await expect(
        resumeBrowserSession(runtime, {}, logger, { recoverSession, recoveryLockPath }),
      ).rejects.toThrow(/already in progress/i);
      await first.abandon();
      const next = await resumeBrowserSession(runtime, {}, logger, {
        recoverSession,
        recoveryLockPath,
      });
      await next.abandon();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not finalize resources after failed fallback recovery", async () => {
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const removeProfile = vi.fn(async () => true);
    const runtime = withCommittedPromptEpoch({
      chromePort: 9222,
      userDataDir: path.join(os.tmpdir(), "oracle-browser-failed-recovery"),
      recoveryCleanup: {
        transport: "local",
        ownsTarget: false,
        profileKind: "temporary",
        keepBrowser: false,
      },
    });

    await expect(
      resumeBrowserSession(runtime, {}, vi.fn() as BrowserLogger, {
        listTargets: vi.fn(async () => {
          throw new Error("live capture failed");
        }),
        recoverSession: vi.fn(async () => {
          throw new Error("fallback capture failed");
        }),
        recoveryCleanup: { terminateRecordedChromeForProfile, removeProfile },
      }),
    ).rejects.toThrow("fallback capture failed");
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
  });
});

describe("reattach helpers", () => {
  const {
    pickTarget,
    extractConversationIdFromUrl,
    buildConversationUrl,
    openConversationFromSidebar,
    createOwnedRecoveryTargetConnection,
  } = __test__;
  type EvaluateParams = { expression: string };
  type EvaluateResult<T> = { result: { value: T } };

  test("extracts conversation id from a chat URL", () => {
    expect(extractConversationIdFromUrl("https://chatgpt.com/c/abc-123")).toBe("abc-123");
    expect(
      extractConversationIdFromUrl(
        "https://chatgpt.com/c/WEB:32229414-5afa-4478-890c-9ca80aa82430",
      ),
    ).toBeUndefined();
    expect(extractConversationIdFromUrl("")).toBeUndefined();
  });

  test("builds conversation URL from tabUrl or conversationId", () => {
    expect(
      buildConversationUrl(
        { tabUrl: "https://chatgpt.com/c/live", conversationId: "ignored" },
        "https://chatgpt.com/",
      ),
    ).toBe("https://chatgpt.com/c/live");
    expect(buildConversationUrl({ conversationId: "abc" }, "https://chatgpt.com/")).toBe(
      "https://chatgpt.com/c/abc",
    );
  });

  test("creates and binds a dedicated owned recovery target", async () => {
    const logger = vi.fn() as BrowserLogger;
    const createRecoveryTarget = vi.fn(async () => "created-target");
    const closeConnection = vi.fn(async () => undefined);
    const connectRecoveryTarget = vi.fn(async () => ({
      client: { close: vi.fn(async () => undefined) } as unknown as ChromeClient,
      targetId: "created-target",
      ownership: "attached" as const,
      close: closeConnection,
    }));

    const connection = await createOwnedRecoveryTargetConnection(
      { host: "127.0.0.1", port: 63333 },
      logger,
      { createRecoveryTarget, connectRecoveryTarget },
    );

    expect(createRecoveryTarget).toHaveBeenCalledWith(63333, logger, "127.0.0.1");
    expect(connectRecoveryTarget).toHaveBeenCalledWith("127.0.0.1", 63333, logger, {
      targetId: "created-target",
      closeTargetOnDispose: false,
    });
    expect(connection).toMatchObject({ targetId: "created-target", ownership: "created" });
    await connection.close();
    expect(closeConnection).toHaveBeenCalledOnce();
  });

  test("rejects a recovery connection that is not bound to the created target", async () => {
    const logger = vi.fn() as BrowserLogger;
    const closeConnection = vi.fn(async () => undefined);
    const closeChromeTarget = vi.fn(async () => true);

    await expect(
      createOwnedRecoveryTargetConnection({ host: "127.0.0.1", port: 63333 }, logger, {
        createRecoveryTarget: vi.fn(async () => "created-target"),
        connectRecoveryTarget: vi.fn(async () => ({
          client: { close: vi.fn(async () => undefined) } as unknown as ChromeClient,
          targetId: "different-target",
          ownership: "attached" as const,
          close: closeConnection,
        })),
        recoveryCleanup: { closeChromeTarget },
      }),
    ).rejects.toThrow(/different-target.*created-target/i);
    expect(closeConnection).toHaveBeenCalledOnce();
    expect(closeChromeTarget).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 63333,
      targetId: "created-target",
      logger,
    });
  });

  test("pickTarget requires the stored target and committed conversation to match", () => {
    const targets = [
      { targetId: "t-1", type: "page", url: "https://chatgpt.com/c/first" },
      { targetId: "t-2", type: "page", url: "https://chatgpt.com/c/second" },
      { targetId: "t-3", type: "page", url: "about:blank" },
    ];
    expect(
      pickTarget(targets, {
        chromeTargetId: "t-1",
        tabUrl: "https://chatgpt.com/c/first",
        conversationId: "first",
      }),
    ).toEqual(targets[0]);
    expect(
      pickTarget(targets, {
        chromeTargetId: "t-2",
        tabUrl: "https://chatgpt.com/c/first",
        conversationId: "first",
      }),
    ).toBeUndefined();
    expect(pickTarget(targets, { tabUrl: "https://chatgpt.com/c/first" })).toBeUndefined();
    expect(pickTarget(targets, {})).toBeUndefined();
    expect(
      pickTarget([{ targetId: "external", type: "page", url: "https://example.com/c/first" }], {
        chromeTargetId: "external",
        conversationId: "first",
      }),
    ).toBeUndefined();
  });

  test("pickTarget permits only an explicitly referenced borrowed target", () => {
    const targets = [
      { targetId: "t-1", type: "page", url: "https://chatgpt.com/c/first" },
      { targetId: "t-2", type: "page", url: "https://chatgpt.com/c/second" },
    ];
    expect(pickTarget(targets, { conversationId: "second" }, "t-2")).toEqual(targets[1]);
    expect(pickTarget(targets, { conversationId: "second" }, "second")).toEqual(targets[1]);
    expect(pickTarget(targets, { conversationId: "second" }, "missing")).toBeUndefined();
    expect(pickTarget(targets, { conversationId: "second" }, "current")).toBeUndefined();
    const ambiguous = [
      { targetId: "same-1", type: "page", url: "https://chatgpt.com/c/same" },
      { targetId: "same-2", type: "page", url: "https://chatgpt.com/c/same" },
    ];
    expect(pickTarget(ambiguous, { conversationId: "same" }, "same")).toBeUndefined();
    expect(
      pickTarget(ambiguous, { conversationId: "same" }, "https://chatgpt.com/c/same"),
    ).toBeUndefined();
  });

  test("pickTarget keeps the saved target among duplicate conversation tabs", () => {
    const targets = [
      { targetId: "duplicate", type: "page", url: "https://chatgpt.com/c/same" },
      { targetId: "submitted", type: "page", url: "https://chatgpt.com/c/same" },
    ];

    expect(
      pickTarget(targets, {
        chromeTargetId: "submitted",
        conversationId: "same",
      }),
    ).toEqual(targets[1]);
  });

  test("pickTarget understands CDP list ids when conversation identity agrees", () => {
    const targets = [
      { id: "page-1", type: "page", url: "https://chatgpt.com/c/first" },
      { id: "page-2", type: "page", url: "about:blank" },
    ];

    expect(
      pickTarget(targets, {
        chromeTargetId: "page-1",
        conversationId: "first",
      }),
    ).toEqual(targets[0]);
  });

  test("openConversationFromSidebar passes conversationId and projects preference", async () => {
    const evaluate = vi.fn<
      (
        params: EvaluateParams,
      ) => Promise<EvaluateResult<{ ok: boolean; href?: string; count: number }>>
    >(async () => ({
      result: { value: { ok: true, href: "https://chatgpt.com/c/abc", count: 3 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, {
      conversationId: "abc",
      preferProjects: true,
    });

    expect(ok).toBe(true);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain('const conversationId = "abc"');
    expect(call?.expression).toContain("const preferProjects = true");
  });

  test("openConversationFromSidebar handles missing conversationId", async () => {
    const evaluate = vi.fn<
      (params: EvaluateParams) => Promise<EvaluateResult<{ ok: boolean; count: number }>>
    >(async () => ({
      result: { value: { ok: false, count: 0 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, { preferProjects: false });

    expect(ok).toBe(false);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain("const conversationId = null");
    expect(call?.expression).toContain("const preferProjects = false");
  });
});
