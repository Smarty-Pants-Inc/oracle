import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resumeBrowserSession, __test__ } from "../../src/browser/reattach.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import type { BrowserRunTransaction, ChromeClient } from "../../src/browser/types.js";
import {
  createBrowserLogger,
  withCommittedPromptEpoch,
  withOwnedTargetResource,
  withRecoveryCleanup,
  resumeExplicitTargetFixture,
  type FakeClient,
  type FakeTarget,
} from "./reattachTestHelpers.js";

describe("resumeBrowserSession selection", { timeout: 15_000 }, () => {
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
    const verifyCommittedPromptTurn = vi.fn(async () => undefined);
    const logger = createBrowserLogger();

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
        verifyCommittedPromptTurn,
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
    await result.abort();
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
    const logger = createBrowserLogger();

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
    await result.abort();
  });
  test("fails closed when the original target is missing among unrelated user tabs", async () => {
    const profileRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-refresh-"));
    const refreshedPort = 63332;
    const fallbackProfileRoot = path.join(profileRoot, "fallback-profile");
    await writeFile(
      path.join(profileRoot, "DevToolsActivePort"),
      `${refreshedPort}\n/devtools/browser/refreshed\n`,
      "utf8",
    );

    try {
      const runtime = withCommittedPromptEpoch(
        withRecoveryCleanup(
          {
            chromePort: 41111,
            chromeHost: "127.0.0.1",
            chromeBrowserWSEndpoint: "ws://127.0.0.1:41111/devtools/browser/stale",
            chromeProfileRoot: profileRoot,
            chromeTargetId: "missing-original-target",
            tabUrl: "https://chatgpt.com/c/abc",
          },
          {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        ),
      );
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
        },
      }));

      const result = await resumeBrowserSession(runtime, {}, createBrowserLogger(), {
        listTargets,
        connect,
        waitForConversationHydration,
        recoverSession,
      });

      expect(result.answerMarkdown).toBe("fallback-md");
      expect(connect).not.toHaveBeenCalled();
      expect(waitForConversationHydration).not.toHaveBeenCalled();
      expect(recoverSession).toHaveBeenCalledWith(
        expect.objectContaining({
          chromePort: 41111,
          chromeBrowserWSEndpoint: "ws://127.0.0.1:41111/devtools/browser/stale",
          chromeTargetId: undefined,
        }),
        {},
      );
      expect(result.runtime.recoveryCleanupResources).toEqual([
        expect.objectContaining({
          chromePort: 41111,
          chromeBrowserWSEndpoint: "ws://127.0.0.1:41111/devtools/browser/stale",
          chromeTargetId: "missing-original-target",
        }),
      ]);

      const finalized = await result.finalize();
      expect(finalized).toMatchObject({
        status: "pending",
        error: expect.stringContaining("Pre-upgrade browser session"),
      });
    } finally {
      await rm(profileRoot, { recursive: true, force: true });
    }
  });

  test("does not recover when an explicit browser tab reference is missing", async () => {
    const runtime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "stored-target",
      tabUrl: "https://chatgpt.com/c/abc",
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "must not recover",
      answerMarkdown: "must not recover",
    }));
    const connect = vi.fn();

    await expect(
      resumeBrowserSession(
        runtime,
        { browserTabRef: "missing-explicit-target", timeoutMs: 2_000 },
        createBrowserLogger(),
        {
          listTargets: vi.fn(async () => [
            { targetId: "other-target", type: "page", url: runtime.tabUrl },
          ]),
          connect,
          recoverSession,
        },
      ),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "explicit-browser-tab-missing",
        reattachClassification: "explicit-selector-terminal",
      }),
    });

    expect(connect).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("does not recover when an explicit browser tab reference is ambiguous", async () => {
    const runtime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "stored-target",
      tabUrl: "https://chatgpt.com/c/abc",
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "must not recover",
      answerMarkdown: "must not recover",
    }));
    const connect = vi.fn();

    await expect(
      resumeBrowserSession(
        runtime,
        { browserTabRef: "abc", timeoutMs: 2_000 },
        createBrowserLogger(),
        {
          listTargets: vi.fn(async () => [
            { targetId: "duplicate-1", type: "page", url: runtime.tabUrl },
            { targetId: "duplicate-2", type: "page", url: runtime.tabUrl },
          ]),
          connect,
          recoverSession,
        },
      ),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "explicit-browser-tab-ambiguous",
        reattachClassification: "explicit-selector-terminal",
      }),
    });

    expect(connect).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("rejects explicit target authority before remote recovery contact or persistence", async () => {
    const remoteRecovery = {
      protocolVersion: 3,
      host: "remote.example.test:9443",
      transactionToken: "e".repeat(64),
      state: "pending" as const,
    };
    const runtime = withRecoveryCleanup(
      {},
      {
        ownsTarget: false,
        profileKind: "none",
        keepBrowser: false,
      },
      remoteRecovery,
    );
    const acquireRecoveryLock = vi.fn();
    const resolveRemoteRecoveryConfig = vi.fn();
    const resumeRemoteBrowserTransaction = vi.fn();
    const runtimeHintCb = vi.fn();

    await expect(
      resumeBrowserSession(
        runtime,
        { browserTabRef: "explicit-remote-target", timeoutMs: 2_000 },
        createBrowserLogger(),
        {
          acquireRecoveryLock,
          resumeRemoteBrowserTransaction,
          runtimeHintCb,
          recoveryCleanup: { resolveRemoteRecoveryConfig },
        },
      ),
    ).rejects.toMatchObject({
      details: {
        stage: "browser-reattach-explicit-target",
        code: "explicit-browser-tab-unsupported",
        browserTabRef: "explicit-remote-target",
        reattachClassification: "explicit-selector-terminal",
      },
    });

    expect(acquireRecoveryLock).not.toHaveBeenCalled();
    expect(resolveRemoteRecoveryConfig).not.toHaveBeenCalled();
    expect(resumeRemoteBrowserTransaction).not.toHaveBeenCalled();
    expect(runtimeHintCb).not.toHaveBeenCalled();
  });

  test("allows explicit-only local tab selection without claiming ownership", async () => {
    const runtime = withCommittedPromptEpoch(
      withRecoveryCleanup(
        {
          chromePort: 51559,
          chromeHost: "127.0.0.1",
          chromeTargetId: "missing-original-target",
          tabUrl: "https://chatgpt.com/c/abc",
        },
        {
          ownsTarget: false,
          profileKind: "none",
          keepBrowser: true,
        },
      ),
    );
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
    const resumeRemoteBrowserTransaction = vi.fn();

    const result = await resumeBrowserSession(
      runtime,
      { browserTabRef: "borrowed-target", timeoutMs: 2_000 },
      createBrowserLogger(),
      {
        listTargets,
        connect,
        waitForConversationHydration: vi.fn(async () => 2),
        verifyCommittedPromptTurn: vi.fn(async () => undefined),
        waitForAssistantResponse: vi.fn(async () => ({
          text: "borrowed capture",
          html: "",
          meta: { messageId: "m1", turnId: "conversation-turn-3" },
        })),
        captureAssistantMarkdown: vi.fn(async () => "borrowed capture"),
        resumeRemoteBrowserTransaction,
      },
    );

    expect(result.runtime).toMatchObject({
      chromeTargetId: "borrowed-target",
      recoveryCleanupResources: [
        expect.objectContaining({
          chromeTargetId: "missing-original-target",
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "none",
            keepBrowser: true,
          },
        }),
      ],
    });
    expect((await result.finalize()).status).toBe("completed");
    expect(resumeRemoteBrowserTransaction).not.toHaveBeenCalled();
  });

  test("keeps owned T1 unchanged while explicitly borrowing T2 in the same conversation", async () => {
    const baseRuntime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "owned-t1",
      tabUrl: "https://chatgpt.com/c/shared",
    });
    const capability = {
      version: 1 as const,
      generationId: "owned-generation",
      capabilityId: "owned-capability",
    };
    const runtime = withOwnedTargetResource(baseRuntime, "owned-t1", capability);
    const closeChromeTargetWithRetainedCapability = vi.fn(async () => ({
      status: "completed" as const,
    }));

    const { result } = await resumeExplicitTargetFixture({
      runtime,
      browserTabRef: "borrowed-t2",
      targets: [
        { targetId: "owned-t1", type: "page", url: runtime.tabUrl },
        { targetId: "borrowed-t2", type: "page", url: runtime.tabUrl },
      ],
      recoveryCleanup: { closeChromeTargetWithRetainedCapability },
    });

    expect(result.runtime.chromeTargetId).toBe("borrowed-t2");
    expect(result.runtime.recoveryCleanupResources).toEqual(runtime.recoveryCleanupResources);
    expect(__test__.bindReattachTarget(runtime, "borrowed-t2")).toEqual({
      ...runtime,
      chromeTargetId: "borrowed-t2",
    });

    const boundRuntime = await result.bindSettlement("finalize");
    expect(boundRuntime.recoveryCleanupResources).toEqual(runtime.recoveryCleanupResources);
    expect(boundRuntime.recoveryCleanupResult).toMatchObject({
      status: "pending",
      settlementMode: "finalize",
    });
    expect(closeChromeTargetWithRetainedCapability).not.toHaveBeenCalled();

    const finalized = await result.finalize();
    expect(closeChromeTargetWithRetainedCapability).toHaveBeenCalledWith({
      capability,
      targetId: "owned-t1",
      logger: expect.any(Function),
    });
    expect(finalized).toMatchObject({
      status: "completed",
      runtime: { chromeTargetId: "borrowed-t2" },
    });
    expect(finalized.runtime.recoveryCleanupResources).toBeUndefined();
  });

  test("retains selector-named T1 ownership after exact generation proof", async () => {
    const baseRuntime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "owned-t1",
      tabUrl: "https://chatgpt.com/c/shared",
    });
    const capability = {
      version: 1 as const,
      generationId: "owned-generation",
      capabilityId: "owned-capability",
    };
    const runtime = withOwnedTargetResource(baseRuntime, "owned-t1", capability);
    const closeChromeTargetWithRetainedCapability = vi.fn(async () => ({
      status: "completed" as const,
    }));

    const { result } = await resumeExplicitTargetFixture({
      runtime,
      browserTabRef: "owned-t1",
      targets: [
        { targetId: "owned-t1", type: "page", url: runtime.tabUrl },
        { targetId: "borrowed-t2", type: "page", url: runtime.tabUrl },
      ],
      recoveryCleanup: { closeChromeTargetWithRetainedCapability },
    });

    expect(__test__.bindReattachTarget(runtime, "owned-t1")).toBe(runtime);
    expect(result.runtime.recoveryCleanupResources).toEqual(runtime.recoveryCleanupResources);
    expect(result.runtime.recoveryCleanupResources?.[0]?.recoveryCleanup.ownsTarget).toBe(true);
    await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
    expect(closeChromeTargetWithRetainedCapability).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "owned-t1", capability }),
    );
  });

  test("keeps unproven selector-named T1 pending without downgrading ownership", async () => {
    const baseRuntime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "owned-t1",
      tabUrl: "https://chatgpt.com/c/shared",
    });
    const runtime = withOwnedTargetResource(baseRuntime, "owned-t1");
    const closeChromeTargetWithRetainedCapability = vi.fn(async () => ({
      status: "completed" as const,
    }));

    const { result } = await resumeExplicitTargetFixture({
      runtime,
      browserTabRef: "owned-t1",
      targets: [{ targetId: "owned-t1", type: "page", url: runtime.tabUrl }],
      recoveryCleanup: { closeChromeTargetWithRetainedCapability },
    });

    expect(__test__.bindReattachTarget(runtime, "owned-t1")).toBe(runtime);
    expect(result.runtime.recoveryCleanupResources).toEqual(runtime.recoveryCleanupResources);
    expect(result.runtime.recoveryCleanupResources?.[0]?.recoveryCleanup.ownsTarget).toBe(true);
    await expect(result.finalize()).resolves.toMatchObject({
      status: "pending",
      runtime: {
        recoveryCleanupResources: [
          expect.objectContaining({
            chromeTargetId: "owned-t1",
            recoveryCleanup: expect.objectContaining({ ownsTarget: true }),
          }),
        ],
      },
    });

    expect(closeChromeTargetWithRetainedCapability).not.toHaveBeenCalled();
  });
  test("resumes projected pre-receipt remote authority without a local committed epoch", async () => {
    const requestIdentity = {
      acceptedPromptSha256: ["a".repeat(64)],
      followUpOrdinal: 0,
      remainingFollowUps: 0 as const,
    };
    const remoteRecovery = {
      protocolVersion: 3,
      host: "remote.example.test:9443",
      transactionToken: "d".repeat(64),
      state: "pre-receipt" as const,
      requestIdentity,
    };
    const runtime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery,
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "none",
            keepBrowser: false,
          },
        },
      ],
    };
    const capturedRecovery = { ...remoteRecovery, state: "pending" as const };
    const capturedRuntime = withCommittedPromptEpoch(
      withRecoveryCleanup(
        {},
        {
          ownsTarget: false,
          profileKind: "none",
          keepBrowser: false,
        },
        capturedRecovery,
      ),
    );
    const settlementEvents: string[] = [];
    const finalize = vi.fn(async () => {
      settlementEvents.push("cleanup:finalize");
      return { status: "completed" as const, runtime: {} };
    });
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    const recoveredFile = {
      kind: "file" as const,
      path: "/tmp/recovering-session/artifacts/result.zip",
      label: "Recovered file",
      url: "bridge-artifact",
      filename: "result.zip",
    };
    const recoveredArtifacts = [
      recoveredFile,
      {
        kind: "deep-research-report" as const,
        path: "/tmp/recovering-session/artifacts/deep-research-report.md",
      },
      {
        kind: "transcript" as const,
        path: "/tmp/recovering-session/artifacts/transcript.md",
      },
    ];
    const recoveredModel = {
      requestedModel: "Pro",
      resolvedLabel: "Pro",
      strategy: "select" as const,
      status: "already-selected" as const,
      verified: true,
      source: "chatgpt-model-picker" as const,
      capturedAt: "2026-08-05T00:00:00.000Z",
    };
    const transaction = {
      answerText: "remote answer",
      answerMarkdown: "remote markdown",
      answerHtml: "<p>remote answer</p>",
      artifacts: recoveredArtifacts,
      savedFiles: [recoveredFile],
      archive: { mode: "auto" as const, attempted: true, archived: true },
      modelSelection: recoveredModel,
      warnings: [
        { code: "remote-warning", severity: "warning" as const, message: "Recovered warning" },
      ],
      tookMs: 1,
      answerTokens: 2,
      answerChars: 13,
      browserTransport: "cdp" as const,
      runtime: capturedRuntime,
      bindSettlement: vi.fn(async (mode: "finalize" | "abort") => ({
        ...capturedRuntime,
        recoveryCleanupResult: { status: "pending" as const, settlementMode: mode },
      })),
      finalize,
      abort,
    } satisfies BrowserRunTransaction;
    const resumeRemoteBrowserTransaction = vi.fn(async () => transaction);
    const listTargets = vi.fn(async () => []);
    const recoverSession = vi.fn(async () => ({
      answerText: "local fallback",
      answerMarkdown: "local fallback",
    }));
    const runtimeHintCb = vi.fn(async (hintedRuntime: BrowserRuntimeMetadata) => {
      settlementEvents.push(
        `persist:${hintedRuntime.recoveryCleanupResult?.settlementMode ?? "unbound"}`,
      );
    });
    const release = vi.fn(async () => undefined);

    const result = await resumeBrowserSession(runtime, {}, createBrowserLogger(), {
      sessionId: "recovering-session",
      resumeRemoteBrowserTransaction,
      listTargets,
      recoverSession,
      runtimeHintCb,
      acquireRecoveryLock: vi.fn(async () => ({ release })),
      recoveryCleanup: {
        resolveRemoteRecoveryConfig: vi.fn(async () => ({
          host: remoteRecovery.host,
          token: "remote-auth-token",
        })),
      },
    });

    expect(result).toMatchObject({
      answerMarkdown: "remote markdown",
      answerHtml: "<p>remote answer</p>",
      artifacts: recoveredArtifacts,
      savedFiles: [recoveredFile],
      archive: { mode: "auto", attempted: true, archived: true },
      modelSelection: recoveredModel,
      warnings: [{ code: "remote-warning", severity: "warning", message: "Recovered warning" }],
      tookMs: 1,
      answerTokens: 2,
      answerChars: 13,
      browserTransport: "cdp",
    });
    expect(resumeRemoteBrowserTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime,
        configuredHost: remoteRecovery.host,
        authToken: "remote-auth-token",
        sessionId: "recovering-session",
        runtimeHintCb,
      }),
    );
    expect(listTargets).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
    expect((await result.finalize()).status).toBe("completed");
    expect(settlementEvents).toEqual([
      "persist:finalize",
      "cleanup:finalize",
      "persist:finalize",
      "persist:unbound",
    ]);
    expect(runtimeHintCb).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
      }),
    );
    expect(runtimeHintCb).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ recoveryCleanupResult: expect.anything() }),
    );
    expect(finalize).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
