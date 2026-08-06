import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  resumeBrowserSession,
  retryBrowserRecoveryCleanup,
  __test__,
  type ReattachCleanupDeps,
} from "../../src/browser/reattach.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import type { BrowserRecoveryCleanupResourceMetadata } from "../../src/sessionManager.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";
import {
  captureProfileDirectoryIdentity,
  readOracleChromeOwner,
  writeOracleChromeOwner,
  type ChromeProcessIdentity,
  type OracleChromeOwnerRecord,
} from "../../src/browser/profileState.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import {
  authenticatedLocalTargetCleanupDeps,
  createBrowserLogger,
  physicalChromeProcessIdentity,
  resumeFallbackWithManualOwner,
  withCommittedPromptEpoch,
  withRetainedTargetCapability,
  type FakeClient,
  type FakeTarget,
} from "./reattachTestHelpers.js";

describe("resumeBrowserSession acquisition", { timeout: 15_000 }, () => {
  test("preserves exact abort cleanup authority without entering answer reattach", async () => {
    const runtime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "cleanup-only-target",
      tabUrl: "https://chatgpt.com/c/cleanup-only",
      recoveryCleanupResources: [
        withRetainedTargetCapability({
          chromePort: 51559,
          chromeHost: "127.0.0.1",
          chromeTargetId: "cleanup-only-target",
          conversationId: "cleanup-only",
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        }),
      ],
    });
    if (runtime.promptEpoch?.status !== "committed") throw new Error("missing committed epoch");
    runtime.promptEpoch.remainingFollowUps = 1;
    const listTargets = vi.fn();
    const waitForAssistantResponse = vi.fn();
    const recoverSession = vi.fn();

    await expect(
      resumeBrowserSession(runtime, {}, createBrowserLogger(), {
        listTargets,
        waitForAssistantResponse,
        recoverSession,
      }),
    ).rejects.toMatchObject({
      details: {
        code: "committed-prompt-identity-mismatch",
        reattachClassification: "cleanup-only-abort",
        remainingFollowUps: 1,
        runtime,
      },
    });
    expect(listTargets).not.toHaveBeenCalled();
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("rejects a live conversation whose committed prompt identity no longer matches", async () => {
    const runtime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    });
    const listTargets = vi.fn(async () => [
      { targetId: "target-1", type: "page", url: runtime.tabUrl },
    ]) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
      result: { value: expression === "location.href" ? runtime.tabUrl : 2 },
    }));
    const close = vi.fn(async () => undefined);
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn();
    const captureAssistantMarkdown = vi.fn();
    const recoverSession = vi.fn();
    const verifyCommittedPromptTurn = vi.fn(async () => {
      throw new BrowserAutomationError("Committed prompt digest differs from the live user turn.", {
        stage: "browser-recovery-prompt-identity",
        code: "committed-prompt-identity-mismatch",
      });
    });

    await expect(
      resumeBrowserSession(runtime, { timeoutMs: 2000 }, createBrowserLogger(), {
        listTargets,
        connect,
        waitForConversationHydration: vi.fn(async () => 2),
        verifyCommittedPromptTurn,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        recoverSession,
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: "committed-prompt-identity-mismatch" }),
    });

    expect(close).toHaveBeenCalledOnce();
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(captureAssistantMarkdown).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
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
    const verifyCommittedPromptTurn = vi.fn(async () => undefined);
    const logger = createBrowserLogger();
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
        verifyCommittedPromptTurn,
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
      expect.objectContaining({
        requireScopedTargetOwner: true,
        expectedConversationId: "deep",
        expectedPromptTurn: expect.objectContaining({
          conversationId: "deep",
          verifiedUserTurnIndex: 1,
          verifiedUserTurnId: "turn-1",
          verifiedUserMessageId: "message-1",
        }),
      }),
    );
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    await result.abort();
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
    const logger = createBrowserLogger();

    const result = await resumeBrowserSession(runtime, {}, logger, { recoverSession });

    expect(result.answerMarkdown).toBe("fallback-md");
    expect(recoverSession).toHaveBeenCalled();
    await result.abort();
  });

  test("journals fallback acquisition intent and exact identities before later side effects", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-journal-order-"));
    try {
      const {
        result,
        acquisitionOrder,
        runtimeHints,
        acquireBrowserTabLease,
        acquireManualChromeOwner,
        connectRecoveryTargetWithExactAuthority,
      } = await resumeFallbackWithManualOwner(profileDir, "launched");

      expect(acquisitionOrder).toEqual([
        "persist:tab-lease",
        "acquire:tab-lease",
        "persist:acquired",
        "persist:chrome-process",
        "acquire:chrome-process",
        "persist:acquired",
        "persist:chrome-target",
        "acquire:chrome-target",
        "persist:acquired",
      ]);
      const leaseIntent = runtimeHints[0]?.recoveryCleanupResources?.at(-1);
      const targetIntent = runtimeHints[4]?.recoveryCleanupResources?.at(-1);
      const acquired = runtimeHints[5]?.recoveryCleanupResources?.at(-1);
      expect(leaseIntent).toMatchObject({
        tabLease: { id: expect.any(String) },
        acquisition: {
          generationId: expect.any(String),
          pendingResource: "tab-lease",
          processLaunchClaim: {
            version: 1,
            generationId: expect.any(String),
            nonce: expect.any(String),
          },
          processOwnerDisposition: "close-on-last-lease",
        },
      });
      expect(acquireBrowserTabLease).toHaveBeenCalledWith(
        profileDir,
        expect.objectContaining({ leaseId: leaseIntent?.tabLease?.id }),
      );
      expect(acquireManualChromeOwner).toHaveBeenCalledWith(
        profileDir,
        expect.any(Object),
        expect.any(Function),
        expect.any(String),
        { launchClaim: leaseIntent?.acquisition?.processLaunchClaim },
      );
      expect(targetIntent).toMatchObject({
        chromeProcessIdentity: expect.any(Object),
        acquisition: {
          generationId: leaseIntent?.acquisition?.generationId,
          pendingResource: "chrome-target",
          targetMarkerUrl: expect.stringContaining("oracle-acquisition="),
        },
      });
      expect(connectRecoveryTargetWithExactAuthority).toHaveBeenCalledWith({
        authority: expect.objectContaining({
          browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/fallback-owner",
        }),
        targetUrl: targetIntent?.acquisition?.targetMarkerUrl,
        closeTargetOnDispose: false,
      });
      expect(acquired).toMatchObject({
        chromeTargetId: "fallback-owned-target",
        targetCloseCapability: {
          version: 1,
          generationId: leaseIntent?.acquisition?.generationId,
          capabilityId: expect.any(String),
        },
        acquisition: { generationId: leaseIntent?.acquisition?.generationId },
      });
      expect(acquired?.acquisition?.pendingResource).toBeUndefined();

      await expect(result.abort()).resolves.toMatchObject({ status: "completed" });
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("persists completed fallback abort runtime before rethrowing the primary error", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-abort-runtime-"));
    const primaryError = new Error("assistant capture failed");
    const runtimeHints: BrowserRuntimeMetadata[] = [];
    try {
      await expect(
        resumeFallbackWithManualOwner(profileDir, "launched", {
          captureError: primaryError,
          runtimeHints,
        }),
      ).rejects.toBe(primaryError);

      expect(runtimeHints.some((hint) => (hint.recoveryCleanupResources?.length ?? 0) > 0)).toBe(
        true,
      );
      const persistedAbortRuntime = runtimeHints.at(-1);
      expect(persistedAbortRuntime).toMatchObject({
        conversationId: "test-conversation",
        promptEpoch: { status: "committed", conversationId: "test-conversation" },
      });
      expect(persistedAbortRuntime).not.toHaveProperty("recoveryCleanupResources");
      expect(persistedAbortRuntime).not.toHaveProperty("recoveryCleanupResult");
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("keeps fallback process acquisition pending when owner lookup and launch discovery are unavailable", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-crash-window-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir, 5_151);
    const interruption = new Error("controller interrupted after canonical owner creation");
    const runtimeHints: BrowserRuntimeMetadata[] = [];
    const retainedKill = vi.fn(async () => ({
      status: "unsafe" as const,
      pid: processIdentity.pid,
      reason: "simulated process interruption retained no live kill handle",
    }));
    const retainedRelease = vi.fn(async () => undefined);
    const retainedEndpointAuthority = {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/crash-window",
      kill: retainedKill,
      release: retainedRelease,
    };
    const releaseRecoveryLock = vi.fn(async () => undefined);
    const owner = {
      chrome: {
        pid: processIdentity.pid,
        port: 9222,
        host: "127.0.0.1",
        remoteDebuggingPipes: undefined,
        processIdentity,
        kill: retainedKill,
      },
      processIdentity,
      source: "launched" as const,
      disposition: "close-on-last-lease" as const,
      endpointAuthority: retainedEndpointAuthority,
    };
    const releaseBrowserTabLease = vi.fn(
      async (
        _profileDir: string,
        _leaseId: string,
        _logger?: BrowserLogger,
        options?: {
          onRelease?: (context: { isLastLease: boolean }) => Promise<void>;
          expectedProfileIdentity?: ChromeProcessIdentity["profileDirectory"];
        },
      ) => {
        await options?.onRelease?.({ isLastLease: true });
      },
    );
    const acquireManualChromeOwner = vi.fn(async () => {
      await writeOracleChromeOwner(profileDir, {
        port: owner.chrome.port,
        processIdentity,
        disposition: owner.disposition,
      });
      return owner;
    });
    let persistenceInterrupted = false;

    try {
      await expect(
        resumeBrowserSession(
          withCommittedPromptEpoch({ tabUrl: "https://chatgpt.com/c/crash-window" }),
          { manualLogin: true, manualLoginProfileDir: profileDir, timeoutMs: 1_000 },
          createBrowserLogger(),
          {
            acquireBrowserTabLease: vi.fn(async () => ({
              id: "crash-window-lease",
              profileDirectory: processIdentity.profileDirectory,
              update: vi.fn(async () => undefined),
              release: vi.fn(async () => undefined),
            })) as never,
            acquireManualChromeOwner: acquireManualChromeOwner as never,
            runtimeHintCb: async (hint) => {
              runtimeHints.push(structuredClone(hint));
              if (
                !persistenceInterrupted &&
                hint.recoveryCleanupResources?.at(-1)?.acquisition?.pendingResource ===
                  "chrome-target"
              ) {
                persistenceInterrupted = true;
                throw interruption;
              }
            },
            recoveryCleanup: {
              ...authenticatedLocalTargetCleanupDeps(),
              releaseBrowserTabLease,
            },
            acquireRecoveryLock: vi.fn(async () => ({ release: releaseRecoveryLock })),
          },
        ),
      ).rejects.toMatchObject({ details: { code: "fallback-cleanup-pending" } });

      expect(await readOracleChromeOwner(profileDir)).toMatchObject({
        processIdentity,
        disposition: "close-on-last-lease",
      });
      const ownerRuntime = runtimeHints.find(
        (hint) =>
          hint.recoveryCleanupResources?.at(-1)?.acquisition?.pendingResource === "chrome-target",
      );
      expect(ownerRuntime?.recoveryCleanupResources?.at(-1)?.chromeBrowserWSEndpoint).toBe(
        retainedEndpointAuthority.browserWSEndpoint,
      );
      const crashRuntime = runtimeHints.find(
        (hint) =>
          hint.recoveryCleanupResources?.at(-1)?.acquisition?.pendingResource === "chrome-process",
      );
      if (!crashRuntime) throw new Error("Chrome process acquisition intent was not persisted");
      const crashResource = crashRuntime?.recoveryCleanupResources?.at(-1);
      expect(crashResource).toMatchObject({
        acquisition: {
          pendingResource: "chrome-process",
          processOwnerProvenance: "manual-canonical-owner",
          processLaunchClaim: {
            version: 1,
            generationId: expect.any(String),
            nonce: expect.any(String),
          },
          processOwnerDisposition: "close-on-last-lease",
        },
      });
      expect(crashResource?.chromeProcessIdentity).toBeUndefined();
      expect(retainedKill).toHaveBeenCalledOnce();
      retainedKill.mockClear();

      const terminateRecordedChromeForProfile = vi.fn(async () => ({
        status: "stopped" as const,
        pid: processIdentity.pid,
        signal: "SIGTERM" as const,
      }));
      const releaseAcquisitionRecoveryLock = vi.fn(async () => undefined);
      const recovery = await retryBrowserRecoveryCleanup(
        crashRuntime,
        createBrowserLogger(),
        {
          acquireRecoveryLock: vi.fn(async () => ({
            release: releaseAcquisitionRecoveryLock,
          })),
          recoveryCleanup: {
            readOracleChromeOwner: vi.fn(async () => null),
            verifyProfileDirectoryIdentity: vi.fn(async () => true),
            inspectRunningChromeProcessesForLaunchClaim: vi.fn(async () => {
              throw new Error("process enumeration unavailable");
            }),
            terminateRecordedChromeForProfile,
          },
        },
        "abort",
      );

      expect(recovery.status).toBe("pending");
      expect(recovery.runtime.recoveryCleanupResources).toEqual([crashResource]);
      expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
      expect(retainedKill).not.toHaveBeenCalled();
      expect(releaseRecoveryLock).toHaveBeenCalledOnce();
      expect(releaseAcquisitionRecoveryLock).toHaveBeenCalledOnce();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("keeps a pre-owner launch acquisition pending when its durable claim is missing", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-launch-claim-missing-"));
    try {
      const profileDirectoryIdentity = await captureProfileDirectoryIdentity(profileDir);
      const resource: BrowserRecoveryCleanupResourceMetadata = {
        profileDirectoryIdentity,
        chromeHost: "127.0.0.1",
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        acquisition: {
          generationId: "70000000-0000-4000-8000-000000000007",
          pendingResource: "chrome-process",
          processOwnerProvenance: "temporary-launch",
          processOwnerDisposition: "close-on-last-lease",
        },
        recoveryCleanup: {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
          closeOwnedTargetOnComplete: false,
        },
      };
      const inspectRunningChromeProcessesForLaunchClaim = vi.fn();

      const recovery = await __test__.finalizeRecoveredRuntime(
        {
          browserTransport: "cdp",
          chromeHost: "127.0.0.1",
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          recoveryCleanupResources: [resource],
          recoveryCleanupResult: { status: "pending" },
        },
        createBrowserLogger(),
        { inspectRunningChromeProcessesForLaunchClaim },
      );

      expect(recovery).toMatchObject({
        status: "pending",
        runtime: { recoveryCleanupResources: [resource] },
        error: expect.stringMatching(/launch claim is missing or invalid/i),
      });
      expect(inspectRunningChromeProcessesForLaunchClaim).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("keeps recovered process acquisition pending until its endpoint authority releases", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-acquisition-release-retry-"));
    try {
      const launchClaim = {
        version: 1 as const,
        generationId: "80000000-0000-4000-8000-000000000008",
        nonce: "90000000-0000-4000-8000-000000000009",
      };
      const processIdentity = {
        ...(await physicalChromeProcessIdentity(profileDir, 8_008)),
        launchClaim,
      };
      const resource: BrowserRecoveryCleanupResourceMetadata = {
        chromeHost: "127.0.0.1",
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        profileDirectoryIdentity: processIdentity.profileDirectory,
        acquisition: {
          generationId: launchClaim.generationId,
          pendingResource: "chrome-process",
          processOwnerProvenance: "manual-canonical-owner",
          processLaunchClaim: launchClaim,
          processOwnerDisposition: "preserve",
        },
        recoveryCleanup: {
          ownsTarget: false,
          profileKind: "manual-login",
          keepBrowser: false,
          closeOwnedTargetOnComplete: false,
        },
      };
      const endpointRelease = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("transient endpoint release failure"))
        .mockResolvedValueOnce(undefined);
      const endpointAuthority = {
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/recovered-acquisition",
        kill: vi.fn(),
        release: endpointRelease,
      };
      const retainChromeEndpointAuthority = vi.fn(async () => endpointAuthority);
      const recoveryDeps: ReattachCleanupDeps = {
        verifyProfileDirectoryIdentity: vi.fn(async () => true),
        readOracleChromeOwner: vi.fn(async () => null),
        inspectRunningChromeProcessesForLaunchClaim: vi.fn(async () => ({
          exactMatches: [{ pid: processIdentity.pid, port: 9222 }],
          conflictingProfilePids: [],
        })),
        captureChromeProcessIdentity: vi.fn(async () => processIdentity),
        retainChromeEndpointAuthority,
        writeOracleChromeOwner: vi.fn(async () => undefined),
        verifyChromeProcessIdentity: vi.fn(async () => true),
      };
      const runtime: BrowserRuntimeMetadata = {
        browserTransport: "cdp",
        chromeHost: "127.0.0.1",
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        recoveryCleanupResources: [resource],
        recoveryCleanupResult: { status: "pending" },
      };
      const releaseAcquisitionRecoveryLock = vi.fn(async () => undefined);
      const acquireRecoveryLock = vi.fn(async () => ({
        release: releaseAcquisitionRecoveryLock,
      }));

      const pending = await retryBrowserRecoveryCleanup(
        runtime,
        createBrowserLogger(),
        { acquireRecoveryLock, recoveryCleanup: recoveryDeps },
        "abort",
      );

      expect(pending).toMatchObject({
        status: "pending",
        error: "Exact Chrome endpoint release failed: transient endpoint release failure",
        runtime: {
          recoveryCleanupResources: [
            {
              chromeProcessIdentity: processIdentity,
              chromePort: 9222,
              chromeBrowserWSEndpoint: endpointAuthority.browserWSEndpoint,
              acquisition: { pendingResource: "chrome-process" },
              recoveryCleanup: { keepBrowser: true, profileKind: "manual-login" },
            },
          ],
          recoveryCleanupResult: { settlementMode: "abort" },
        },
      });
      expect(retainChromeEndpointAuthority).toHaveBeenCalledOnce();

      const completed = await retryBrowserRecoveryCleanup(
        pending.runtime,
        createBrowserLogger(),
        { acquireRecoveryLock, recoveryCleanup: recoveryDeps },
        "abort",
      );

      expect(completed).toMatchObject({ status: "completed" });
      expect(completed.runtime.recoveryCleanupResources).toBeUndefined();
      expect(endpointRelease).toHaveBeenCalledTimes(2);
      expect(retainChromeEndpointAuthority).toHaveBeenCalledOnce();
      expect(releaseAcquisitionRecoveryLock).toHaveBeenCalledTimes(2);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("does not overwrite a replacement owner published before recovery promotion acquires the profile lock", async () => {
    const profileDir = await mkdtemp(
      path.join(os.tmpdir(), "oracle-browser-owner-promotion-race-"),
    );
    try {
      const launchClaim = {
        version: 1 as const,
        generationId: "a0000000-0000-4000-8000-00000000000a",
        nonce: "a1000000-0000-4000-8000-00000000000a",
      };
      const replacementClaim = {
        version: 1 as const,
        generationId: "b0000000-0000-4000-8000-00000000000b",
        nonce: "b1000000-0000-4000-8000-00000000000b",
      };
      const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
      const replacementOwner = {
        port: 9_223,
        processIdentity: {
          ...(await physicalChromeProcessIdentity(profileDir, 9_223)),
          launchClaim: replacementClaim,
        },
        disposition: "preserve" as const,
      };
      let owner: OracleChromeOwnerRecord | null = null;
      const releasePromotionLock = vi.fn(async () => undefined);
      const acquireProfileRunLock = vi.fn(async () => {
        // The competing publisher completed while recovery was waiting to
        // serialize. Recovery must re-read this replacement under its lock.
        owner = replacementOwner;
        return {
          path: path.join(profileDir, "oracle-automation.lock"),
          lockId: "promotion-race-lock",
          profileDirectory,
          release: releasePromotionLock,
        };
      });
      const writeOracleChromeOwner = vi.fn(
        async (_userDataDir: string, nextOwner: OracleChromeOwnerRecord) => {
          owner = nextOwner;
        },
      );
      const resource: BrowserRecoveryCleanupResourceMetadata = {
        chromeHost: "127.0.0.1",
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        profileDirectoryIdentity: profileDirectory,
        acquisition: {
          generationId: launchClaim.generationId,
          pendingResource: "chrome-process",
          processOwnerProvenance: "temporary-launch",
          processLaunchClaim: launchClaim,
          processOwnerDisposition: "close-on-last-lease",
        },
        recoveryCleanup: {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
          closeOwnedTargetOnComplete: false,
        },
      };

      const recovery = await __test__.finalizeRecoveredRuntime(
        withCommittedPromptEpoch({
          browserTransport: "cdp",
          chromeHost: "127.0.0.1",
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          recoveryCleanupResources: [resource],
          recoveryCleanupResult: { status: "pending" },
        }),
        createBrowserLogger(),
        {
          verifyProfileDirectoryIdentity: vi.fn(async () => true),
          acquireProfileRunLock,
          readOracleChromeOwner: vi.fn(async () => owner),
          writeOracleChromeOwner,
        },
      );

      expect(recovery).toMatchObject({
        status: "pending",
        error: expect.stringMatching(/does not match the persisted launch generation/i),
      });
      expect(owner).toBe(replacementOwner);
      expect(writeOracleChromeOwner).not.toHaveBeenCalled();
      expect(releasePromotionLock).toHaveBeenCalledOnce();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("converges when the exact claimed Chrome generation is already gone", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-claim-gone-"));
    try {
      const profileDirectoryIdentity = await captureProfileDirectoryIdentity(profileDir);
      const launchClaim = {
        version: 1 as const,
        generationId: "80000000-0000-4000-8000-000000000008",
        nonce: "90000000-0000-4000-8000-000000000009",
      };
      const resource: BrowserRecoveryCleanupResourceMetadata = {
        profileDirectoryIdentity,
        chromeHost: "127.0.0.1",
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        acquisition: {
          generationId: launchClaim.generationId,
          pendingResource: "chrome-process",
          processOwnerProvenance: "temporary-launch",
          processLaunchClaim: launchClaim,
          processOwnerDisposition: "close-on-last-lease",
        },
        recoveryCleanup: {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
          closeOwnedTargetOnComplete: false,
        },
      };
      const removeProfile = vi.fn(async () => true);

      const recovery = await __test__.finalizeRecoveredRuntime(
        {
          browserTransport: "cdp",
          chromeHost: "127.0.0.1",
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          recoveryCleanupResources: [resource],
          recoveryCleanupResult: { status: "pending" },
        },
        createBrowserLogger(),
        {
          verifyProfileDirectoryIdentity: vi.fn(async () => true),
          readOracleChromeOwner: vi.fn(async () => null),
          inspectRunningChromeProcessesForLaunchClaim: vi.fn(async () => ({
            exactMatches: [],
            conflictingProfilePids: [],
          })),
          removeProfile,
        },
      );

      expect(recovery.status).toBe("completed");
      expect(recovery.runtime.recoveryCleanupResources).toBeUndefined();
      expect(removeProfile).toHaveBeenCalledWith(profileDir, profileDirectoryIdentity);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test.each([
    [
      "a conflicting profile process",
      { exactMatches: [], conflictingProfilePids: [7_001] },
      /unauthenticated process generation/i,
    ],
    [
      "multiple exact process generations",
      {
        exactMatches: [
          { pid: 7_002, port: 9222 },
          { pid: 7_003, port: 9222 },
        ],
        conflictingProfilePids: [],
      },
      /multiple process generations/i,
    ],
  ] as const)("fails closed when launch recovery finds %s", async (_label, discovery, error) => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-launch-claim-conflict-"));
    try {
      const profileDirectoryIdentity = await captureProfileDirectoryIdentity(profileDir);
      const launchClaim = {
        version: 1 as const,
        generationId: "80000000-0000-4000-8000-000000000008",
        nonce: "90000000-0000-4000-8000-000000000009",
      };
      const resource: BrowserRecoveryCleanupResourceMetadata = {
        profileDirectoryIdentity,
        chromeHost: "127.0.0.1",
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        acquisition: {
          generationId: launchClaim.generationId,
          pendingResource: "chrome-process",
          processOwnerProvenance: "temporary-launch",
          processLaunchClaim: launchClaim,
          processOwnerDisposition: "close-on-last-lease",
        },
        recoveryCleanup: {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
          closeOwnedTargetOnComplete: false,
        },
      };
      const captureChromeProcessIdentity = vi.fn();
      const writeOracleChromeOwner = vi.fn();

      const recovery = await __test__.finalizeRecoveredRuntime(
        {
          browserTransport: "cdp",
          chromeHost: "127.0.0.1",
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          recoveryCleanupResources: [resource],
          recoveryCleanupResult: { status: "pending" },
        },
        createBrowserLogger(),
        {
          verifyProfileDirectoryIdentity: vi.fn(async () => true),
          readOracleChromeOwner: vi.fn(async () => null),
          inspectRunningChromeProcessesForLaunchClaim: vi.fn(async () => discovery),
          captureChromeProcessIdentity,
          writeOracleChromeOwner,
        },
      );

      expect(recovery).toMatchObject({
        status: "pending",
        runtime: { recoveryCleanupResources: [resource] },
        error: expect.stringMatching(error),
      });
      expect(captureChromeProcessIdentity).not.toHaveBeenCalled();
      expect(writeOracleChromeOwner).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });
});
