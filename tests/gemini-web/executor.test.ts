import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import type {
  OracleChromeOwnerRecord,
  RecordedChromeTerminationOutcome,
} from "../../src/browser/profileState.js";
import type { cleanupStaleProfileState as cleanupStaleProfileStateApi } from "../../src/browser/profileState.js";
import { createGeminiWebExecutor } from "../../src/gemini-web/executor.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import type { RetainedChromeEndpointAuthority } from "../../src/browser/chromeLifecycle.js";
import type { ManualChromeOwner } from "../../src/browser/manualChromeOwner.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import { __test__ as targetCloseAuthorityTest } from "../../src/browser/targetCloseAuthority.js";

const {
  launchChrome,
  connectWithNewTabWithExactAuthority,
  closeChromeTargetWithExactAuthority,
  killChrome,
  resolveBrowserConfig,
  readDevToolsPort,
  writeOracleChromeOwner,
  cleanupStaleProfileState,
  verifyDevToolsReachable,
  delay,
  captureProfileDirectoryIdentity,
  acquireManualChromeOwner,
  settleManualChromeOwner,
  releaseManualChromeOwnerEndpointAuthority,
  acquireBrowserTabLease,
  retainBrowserTabLeaseTeardownAuthority,
  teardownSettle,
  teardownState,
} = vi.hoisted(() => ({
  launchChrome: vi.fn(),
  connectWithNewTabWithExactAuthority: vi.fn(),
  closeChromeTargetWithExactAuthority: vi.fn(async () => ({ status: "completed" as const })),
  killChrome: vi.fn<() => Promise<RecordedChromeTerminationOutcome>>(async () => ({
    status: "stopped" as const,
    pid: 12345,
    signal: "CONTROL_CHANNEL" as const,
  })),
  resolveBrowserConfig: vi.fn((input: unknown) => input),
  readDevToolsPort: vi.fn(async () => null),
  writeOracleChromeOwner: vi.fn(
    async (_profileDir: string, _owner: OracleChromeOwnerRecord) => undefined,
  ),
  cleanupStaleProfileState: vi.fn<typeof cleanupStaleProfileStateApi>(
    async (_profileDir, _logger, _options) => true,
  ),
  verifyDevToolsReachable: vi.fn(async () => ({ ok: false, error: "unreachable" })),
  delay: vi.fn(async () => undefined),
  captureProfileDirectoryIdentity: vi.fn(
    async (profileDir: string, _options?: { create?: boolean }) => ({
      version: 1 as const,
      platform: process.platform,
      canonicalPath: profileDir,
      device: "test-device",
      inode: "test-inode",
    }),
  ),
  acquireManualChromeOwner: vi.fn(),
  settleManualChromeOwner: vi.fn(),
  releaseManualChromeOwnerEndpointAuthority: vi.fn(),
  acquireBrowserTabLease: vi.fn(),
  retainBrowserTabLeaseTeardownAuthority: vi.fn(),
  teardownSettle: vi.fn(),
  teardownState: { leaseReleased: false },
}));

const { runGeminiWebWithFallback, saveFirstGeminiImageFromOutput } = vi.hoisted(() => ({
  runGeminiWebWithFallback: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    rawResponseText: "",
    text: "ok",
    thoughts: "thinking",
    metadata: { cid: "1" },
    images: [],
    effectiveModel: "gemini-3.1-pro",
  })),
  saveFirstGeminiImageFromOutput: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    saved: true,
    imageCount: 1,
  })),
}));

vi.mock("../../src/gemini-web/client.js", () => ({
  runGeminiWebWithFallback,
  saveFirstGeminiImageFromOutput,
}));

const { getCookies } = vi.hoisted(() => ({
  getCookies: vi.fn(async () => ({
    cookies: [
      {
        name: "__Secure-1PSID",
        value: "psid",
        domain: "google.com",
        path: "/",
        secure: true,
        httpOnly: true,
      },
      {
        name: "__Secure-1PSIDTS",
        value: "psidts",
        domain: "google.com",
        path: "/",
        secure: true,
        httpOnly: true,
      },
    ],
    warnings: [] as string[],
  })),
}));
vi.mock("@steipete/sweet-cookie", () => ({ getCookies }));
vi.mock("../../src/browser/chromeLifecycle.js", () => ({
  launchChrome,
  connectWithNewTabWithExactAuthority,
  closeChromeTargetWithExactAuthority,
}));
vi.mock("../../src/browser/config.js", () => ({
  resolveBrowserConfig,
}));
vi.mock("../../src/browser/profileState.js", () => ({
  captureProfileDirectoryIdentity,
  cleanupStaleProfileState,
  createChromeProcessLaunchClaim: (generationId: string) => ({
    version: 1 as const,
    generationId,
    nonce: "70000000-0000-4000-8000-000000000007",
  }),
  isSafeChromeTerminationOutcome: (outcome: { status?: string }) =>
    outcome.status === "stopped" || outcome.status === "already-stopped",
  readDevToolsPort,
  writeOracleChromeOwner,
  verifyDevToolsReachable,
}));
vi.mock("../../src/browser/manualChromeOwner.js", () => ({
  acquireManualChromeOwner,
  settleManualChromeOwner,
  releaseManualChromeOwnerEndpointAuthority,
}));
vi.mock("../../src/browser/tabLeaseRegistry.js", () => ({
  DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
  normalizeMaxConcurrentTabs: (value: unknown) => {
    const numeric = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 3;
  },
  acquireBrowserTabLease,
  retainBrowserTabLeaseTeardownAuthority,
}));
vi.mock("../../src/browser/utils.js", () => ({
  delay,
}));

function requiredGeminiCookies() {
  return [
    {
      name: "__Secure-1PSID",
      value: "psid",
      domain: "google.com",
      path: "/",
      secure: true,
      httpOnly: true,
    },
    {
      name: "__Secure-1PSIDTS",
      value: "psidts",
      domain: "google.com",
      path: "/",
      secure: true,
      httpOnly: true,
    },
  ];
}

let runtimeEvaluate: Mock<(input: { expression?: string }) => Promise<unknown>>;

describe("gemini-web executor", () => {
  beforeEach(() => {
    targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
    runGeminiWebWithFallback.mockClear();
    saveFirstGeminiImageFromOutput.mockClear();
    getCookies.mockClear();
    launchChrome.mockReset();
    connectWithNewTabWithExactAuthority.mockReset();
    closeChromeTargetWithExactAuthority.mockReset();
    resolveBrowserConfig.mockClear();
    readDevToolsPort.mockReset();
    writeOracleChromeOwner.mockClear();
    cleanupStaleProfileState.mockClear();
    verifyDevToolsReachable.mockReset();
    delay.mockClear();
    killChrome.mockClear();
    captureProfileDirectoryIdentity.mockClear();
    acquireManualChromeOwner.mockReset();
    settleManualChromeOwner.mockReset();
    releaseManualChromeOwnerEndpointAuthority.mockReset();
    releaseManualChromeOwnerEndpointAuthority.mockImplementation(async (owner: ManualChromeOwner) =>
      owner.endpointAuthority?.release(),
    );
    settleManualChromeOwner.mockImplementation(
      async (profileDir: string, owner: ManualChromeOwner) => {
        if (owner.disposition === "preserve") {
          await releaseManualChromeOwnerEndpointAuthority(owner);
          return { status: "preserved" as const };
        }
        const outcome = await owner.chrome.kill();
        if (outcome.status !== "stopped" && outcome.status !== "already-stopped") {
          return {
            status: "unsafe" as const,
            reason: "reason" in outcome ? outcome.reason : "termination failed",
          };
        }
        const cleaned = await cleanupStaleProfileState(profileDir, undefined, {
          lockRemovalMode: "never",
          expectedProfileIdentity: owner.processIdentity.profileDirectory,
        });
        return cleaned
          ? { status: "terminated" as const }
          : { status: "unsafe" as const, reason: "profile cleanup failed" };
      },
    );
    acquireBrowserTabLease.mockReset();
    retainBrowserTabLeaseTeardownAuthority.mockReset();
    teardownState.leaseReleased = false;
    teardownSettle.mockReset();
    teardownSettle.mockImplementation(async (teardown: () => Promise<boolean>) => {
      teardownState.leaseReleased = true;
      return (await teardown())
        ? { status: "completed", disposition: "teardown-completed" }
        : { status: "preserved", reason: "teardown-unsafe" };
    });
    retainBrowserTabLeaseTeardownAuthority.mockImplementation(() => ({
      get leaseReleased() {
        return teardownState.leaseReleased;
      },
      settle: teardownSettle,
    }));

    launchChrome.mockResolvedValue({
      port: 9222,
      pid: 12345,
      host: "127.0.0.1",
      kill: killChrome,
    });
    acquireManualChromeOwner.mockImplementation(
      async (profileDir: string, config: { keepBrowser: boolean }, logger) => {
        const profileDirectory = await captureProfileDirectoryIdentity(profileDir, {
          create: true,
        });
        const chrome = await launchChrome(config, profileDir, logger);
        const ownerRecord: OracleChromeOwnerRecord = {
          port: chrome.port,
          processIdentity: {
            pid: chrome.pid,
            processStartTime: "2026-08-04T00:00:00.000Z",
            executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            normalizedUserDataDir: profileDirectory.canonicalPath,
            launchNonce: "executor-test-owner",
            profileDirectory,
          },
          disposition: config.keepBrowser ? "preserve" : "close-on-last-lease",
        };
        await writeOracleChromeOwner(profileDir, ownerRecord);
        const endpointAuthority: RetainedChromeEndpointAuthority = {
          browserWSEndpoint: `ws://127.0.0.1:${chrome.port}/devtools/browser/${ownerRecord.processIdentity.launchNonce}`,
          kill: chrome.kill,
          runExactOperation: vi.fn(),
          release: vi.fn(async () => undefined),
        };
        return {
          chrome: { ...chrome, processIdentity: ownerRecord.processIdentity, endpointAuthority },
          processIdentity: ownerRecord.processIdentity,
          source: "launched" as const,
          disposition: ownerRecord.disposition,
          endpointAuthority,
        };
      },
    );
    acquireBrowserTabLease.mockImplementation(async (profileDir: string) => ({
      id: "lease-1",
      profileDirectory: await captureProfileDirectoryIdentity(profileDir, { create: true }),
      update: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    }));
    runtimeEvaluate = vi.fn(async ({ expression }: { expression?: string }) => {
      const source = String(expression ?? "");
      if (source.includes("requiresLogin")) {
        return {
          result: {
            value: {
              ready: true,
              requiresLogin: false,
              href: "https://gemini.google.com/app",
            },
          },
        };
      }
      if (source.includes("beforeUserCount")) {
        return {
          result: {
            value: JSON.stringify({
              userQueryCount: 0,
              responseCount: 0,
              sendResult: "clicked",
              bindingStatus: "bound",
              userStableId: "data-message-id:user-current",
            }),
          },
        };
      }
      if (source.includes("toolbox-drawer-button")) {
        return { result: { value: "clicked" } };
      }
      if (source.includes("beforeUserTurns")) {
        throw new Error("Gemini submission must not use synchronous expando binding.");
      }
      if (source.includes("const ordered =")) {
        return {
          result: {
            value: JSON.stringify({
              entries: [
                {
                  kind: "user",
                  postBaseline: true,
                  text: "hello",
                  stableId: "data-message-id:user-current",
                },
                {
                  kind: "response",
                  postBaseline: true,
                  text: "deep-think answer",
                  stableId: "data-message-id:response-current",
                  completionMarked: true,
                  visibleSpinner: false,
                },
              ],
            }),
          },
        };
      }
      if (source.includes("includes('deep think')")) {
        return { result: { value: "clicked" } };
      }
      if (source.includes("Deselect Deep Think")) {
        return { result: { value: true } };
      }
      if (source.includes("document.execCommand")) {
        return { result: { value: "typed" } };
      }
      if (source.includes("button.send-button")) {
        return { result: { value: "clicked" } };
      }
      if (source.includes("response-footer") && source.includes("status: 'done'")) {
        return {
          result: {
            value: JSON.stringify({
              status: "done",
              text: "deep-think answer",
              causalPair: true,
            }),
          },
        };
      }
      if (source.includes("thoughts-header-button") && source.includes("click")) {
        return { result: { value: { status: "no-toggle" } } };
      }
      if (source.includes("model-thoughts") && source.includes("textContent")) {
        return { result: { value: { status: "empty", text: "" } } };
      }
      return { result: { value: null } };
    });
    connectWithNewTabWithExactAuthority.mockResolvedValue({
      targetId: "target-1",
      client: {
        Runtime: {
          enable: vi.fn(async () => undefined),
          evaluate: runtimeEvaluate,
        },
        Network: {
          enable: vi.fn(async () => undefined),
          getCookies: vi.fn(async () => ({ cookies: requiredGeminiCookies() })),
        },
        Page: {
          enable: vi.fn(async () => undefined),
          navigate: vi.fn(async () => ({ frameId: "f-1" })),
        },
        close: vi.fn(async () => undefined),
      },
    });
    closeChromeTargetWithExactAuthority.mockResolvedValue({ status: "completed" });
    readDevToolsPort.mockResolvedValue(null);
    verifyDevToolsReachable.mockResolvedValue({ ok: false, error: "unreachable" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a generate-image prompt with aspect ratio and passes attachments", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-exec-"));
    const outPath = path.join(tempDir, "gen.jpg");

    const exec = createGeminiWebExecutor({
      generateImage: outPath,
      aspectRatio: "1:1",
      showThoughts: true,
    });
    const result = await exec({
      prompt: "a cute robot holding a banana",
      attachments: [{ path: "/tmp/attach.txt", displayPath: "attach.txt" }],
      config: { desiredModel: "Gemini 3 Pro", chromeProfile: "Default" },
      log: () => {},
    });

    expect(runGeminiWebWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-3.1-pro",
        prompt: "Generate an image: a cute robot holding a banana (aspect ratio: 1:1)",
        files: ["/tmp/attach.txt"],
      }),
    );
    expect(saveFirstGeminiImageFromOutput).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      outPath,
      expect.any(AbortSignal),
    );
    expect(result.answerMarkdown).toContain("## Thinking");
    expect(result.answerMarkdown).toContain("Generated 1 image(s).");
  });

  it("runs the edit flow as two calls and uses intro metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-exec-"));
    const inPath = path.join(tempDir, "in.png");
    const outPath = path.join(tempDir, "out.jpg");

    runGeminiWebWithFallback
      .mockResolvedValueOnce({
        rawResponseText: "",
        text: "intro",
        thoughts: null,
        metadata: { chat: "meta" },
        images: [],
        effectiveModel: "gemini-3.1-pro",
      })
      .mockResolvedValueOnce({
        rawResponseText: "",
        text: "edited",
        thoughts: null,
        metadata: null,
        images: [],
        effectiveModel: "gemini-3.1-pro",
      });

    const exec = createGeminiWebExecutor({ editImage: inPath, outputPath: outPath });
    await exec({
      prompt: "add sunglasses",
      attachments: [],
      config: { desiredModel: "Gemini 3 Pro", chromeProfile: "Default" },
      log: () => {},
    });

    expect(runGeminiWebWithFallback).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        prompt: "Here is an image to edit",
        files: [inPath],
        chatMetadata: null,
      }),
    );
    expect(runGeminiWebWithFallback).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ chatMetadata: { chat: "meta" } }),
    );
    expect(saveFirstGeminiImageFromOutput).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      outPath,
      expect.any(AbortSignal),
    );
  });

  it("uses chromeCookiePath when provided", async () => {
    const exec = createGeminiWebExecutor({});
    await exec({
      prompt: "hello",
      attachments: [],
      config: { desiredModel: "Gemini 3 Pro", chromeCookiePath: "/tmp/Cookies" },
      log: () => {},
    });
    expect(getCookies).toHaveBeenCalledWith(
      expect.objectContaining({ chromeProfile: "/tmp/Cookies" }),
    );
  });

  it("uses inline cookies when cookie sync is disabled", async () => {
    const exec = createGeminiWebExecutor({});
    await exec({
      prompt: "hello",
      attachments: [],
      config: {
        desiredModel: "Gemini 3 Pro",
        cookieSync: false,
        inlineCookies: [
          { name: "__Secure-1PSID", value: "psid", domain: "google.com", path: "/" },
          { name: "__Secure-1PSIDTS", value: "psidts", domain: "google.com", path: "/" },
        ],
        inlineCookiesSource: "test",
      },
      log: () => {},
    });
    expect(getCookies).not.toHaveBeenCalled();
  });

  it("settles the manual CDP session before executing the HTTP Gemini request", async () => {
    const events: string[] = [];
    const acquisitionSnapshots: BrowserRuntimeMetadata[] = [];
    closeChromeTargetWithExactAuthority.mockImplementationOnce(async () => {
      events.push("close-target");
      return { status: "completed" };
    });
    teardownSettle.mockImplementationOnce(async (teardown: () => Promise<boolean>) => {
      events.push("release-lease");
      teardownState.leaseReleased = true;
      return (await teardown())
        ? { status: "completed", disposition: "teardown-completed" }
        : { status: "preserved", reason: "teardown-unsafe" };
    });
    killChrome.mockImplementationOnce(async () => {
      events.push("terminate-owner");
      return { status: "stopped", pid: 12345, signal: "CONTROL_CHANNEL" };
    });
    runGeminiWebWithFallback.mockImplementationOnce(async () => {
      events.push("http-request");
      return {
        rawResponseText: "",
        text: "ok",
        thoughts: null,
        metadata: null,
        images: [],
        effectiveModel: "gemini-3.1-pro",
      };
    });

    const result = await createGeminiWebExecutor({})({
      prompt: "hello",
      attachments: [],
      config: { desiredModel: "Gemini 3 Pro", manualLogin: true, keepBrowser: true },
      log: () => {},
      runtimeHintCb: async (runtime) => {
        acquisitionSnapshots.push(runtime);
        if (!runtime.recoveryCleanupResources?.length) events.push("persist-completed");
      },
    });

    expect(result.answerText).toBe("ok");
    expect(events).toEqual([
      "close-target",
      "release-lease",
      "terminate-owner",
      "persist-completed",
      "http-request",
    ]);
    expect(
      acquisitionSnapshots
        .map((runtime) => runtime.recoveryCleanupResources?.[0]?.acquisition?.pendingResource)
        .filter(Boolean),
    ).toEqual(["tab-lease", "chrome-process", "chrome-target"]);
    expect(
      acquisitionSnapshots.some(
        (runtime) =>
          runtime.recoveryCleanupResources?.[0]?.chromeTargetId === "target-1" &&
          runtime.recoveryCleanupResources[0]?.acquisition?.pendingResource === undefined,
      ),
    ).toBe(true);
    expect(result.runtime.recoveryCleanupResources).toBeUndefined();
    expect(result.runtime.recoveryCleanupResult).toBeUndefined();
  });

  it("returns exact retryable launched-owner authority when manual CDP cleanup fails", async () => {
    killChrome.mockResolvedValueOnce({
      status: "unsafe",
      pid: 12345,
      reason: "termination failed",
    });
    const exec = createGeminiWebExecutor({});

    await expect(
      exec({
        prompt: "hello",
        attachments: [],
        config: { desiredModel: "Gemini 3 Pro", manualLogin: true, keepBrowser: false },
        log: () => {},
      }),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: {
        stage: "gemini-browser-cleanup",
        runtime: {
          recoveryCleanupResult: {
            status: "failed",
            settlementMode: "abort",
            error: expect.stringContaining("could not safely terminate Chrome: termination failed"),
          },
          recoveryCleanupResources: [
            expect.objectContaining({
              chromePid: 12345,
              chromeProcessIdentity: expect.objectContaining({
                pid: 12345,
                launchNonce: "executor-test-owner",
              }),
              tabLease: undefined,
              recoveryCleanup: expect.objectContaining({
                ownsTarget: false,
                keepBrowser: false,
              }),
            }),
          ],
        },
      },
    });
    expect(runGeminiWebWithFallback).not.toHaveBeenCalled();
  });

  it("includes cookie read warnings in the missing-cookie error", async () => {
    getCookies.mockImplementationOnce(async () => ({
      cookies: [],
      warnings: [
        "node:sqlite failed reading Chrome cookies (requires modern Chromium, e.g. Chrome >= 100): Value is too large to be represented as a JavaScript number: 13449189465095212",
      ],
    }));

    const exec = createGeminiWebExecutor({});

    await expect(
      exec({
        prompt: "hello",
        attachments: [],
        config: { desiredModel: "Gemini 3 Pro", chromeProfile: "Default" },
        log: () => {},
      }),
    ).rejects.toThrow(
      /Cookie read warnings:.*Value is too large to be represented as a JavaScript number[\s\S]*--browser-manual-login[\s\S]*--browser-inline-cookies-file/s,
    );
  });

  it("persists acquisition, pending dispatch, and exact commit before publishing capture", async () => {
    const events: string[] = [];
    closeChromeTargetWithExactAuthority.mockImplementationOnce(async () => {
      events.push("close-target");
      return { status: "completed" };
    });
    const runtimeHintCb = vi.fn(async (runtime: BrowserRuntimeMetadata) => {
      const epoch = runtime.promptEpoch?.status ?? "acquired";
      const settlement = runtime.recoveryCleanupResult?.settlementMode;
      events.push(`persist:${epoch}${settlement ? `:${settlement}` : ""}`);
    });
    const exec = createGeminiWebExecutor({});
    const result = await exec({
      prompt: "hello",
      attachments: [],
      config: { desiredModel: "gemini-3-deep-think", keepBrowser: false },
      runtimeHintCb,
      log: () => {},
    });

    expect(result.answerText).toBe("deep-think answer");
    expect(getCookies).not.toHaveBeenCalled();
    expect(launchChrome).toHaveBeenCalled();
    expect(connectWithNewTabWithExactAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/executor-test-owner",
      }),
      expect.any(Function),
      expect.stringMatching(/^about:blank#oracle-acquisition=/),
      { retries: 6 },
    );
    expect(runGeminiWebWithFallback).not.toHaveBeenCalled();
    expect(result.promptEpoch).toMatchObject({
      status: "committed",
      promptSha256: promptIdentitySha256("hello"),
      verifiedUserTurnIndex: 0,
      verifiedUserTurnId: "data-message-id:user-current",
      verifiedUserMessageId: "data-message-id:user-current",
      conversationId: "target-1",
    });
    expect(result.runtime.recoveryCleanupResult).toEqual({ status: "pending" });
    expect(result.runtime.recoveryCleanupResources?.[0]).toMatchObject({
      chromeTargetId: "target-1",
      conversationId: "target-1",
      promptEpoch: expect.objectContaining({ status: "committed" }),
    });
    expect(closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
    expect(killChrome).not.toHaveBeenCalled();
    expect(events.indexOf("persist:pending")).toBeGreaterThan(
      events.lastIndexOf("persist:acquired"),
    );
    expect(events.indexOf("persist:committed")).toBeGreaterThan(events.indexOf("persist:pending"));
    expect(runtimeEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({ awaitPromise: true, returnByValue: true }),
    );

    const finalization = await result.finalize();
    expect(finalization).toMatchObject({
      status: "completed",
      runtime: {
        conversationId: "target-1",
        promptEpoch: expect.objectContaining({
          status: "committed",
          conversationId: "target-1",
          verifiedUserTurnId: "data-message-id:user-current",
        }),
      },
    });
    expect(events.indexOf("persist:committed:finalize")).toBeGreaterThan(
      events.indexOf("persist:committed"),
    );
    expect(events.indexOf("close-target")).toBeGreaterThan(
      events.indexOf("persist:committed:finalize"),
    );
    expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledTimes(1);
    expect(events.lastIndexOf("persist:committed")).toBeGreaterThan(events.indexOf("close-target"));
    expect(killChrome).toHaveBeenCalledTimes(1);
    await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
    expect(killChrome).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      phase: "response",
      expressionMarker: "const ordered =",
      failureMessage: "injected response polling failure",
    },
    {
      phase: "thought",
      expressionMarker: "thoughts-header-button",
      failureMessage: "injected thought capture failure",
    },
  ])(
    "publishes committed recovery authority after a $phase capture failure",
    async ({ expressionMarker, failureMessage }) => {
      const persisted: BrowserRuntimeMetadata[] = [];
      const events: string[] = [];
      const evaluateNormally = runtimeEvaluate.getMockImplementation();
      if (!evaluateNormally) throw new Error("missing Gemini Runtime.evaluate fixture");
      runtimeEvaluate.mockImplementation(async (input: { expression?: string }) => {
        if (String(input.expression ?? "").includes(expressionMarker)) {
          throw new Error(failureMessage);
        }
        return evaluateNormally(input);
      });
      const exec = createGeminiWebExecutor({});

      await expect(
        exec({
          prompt: "hello",
          attachments: [],
          config: { desiredModel: "gemini-3-deep-think", keepBrowser: false },
          runtimeHintCb: async (runtime) => {
            persisted.push(runtime);
            events.push(
              `persist:${runtime.promptEpoch?.status ?? "acquired"}:${runtime.recoveryCleanupResult?.settlementMode ?? "unbound"}`,
            );
          },
          log: () => {},
        }),
      ).rejects.toMatchObject({
        name: "BrowserAutomationError",
        message: expect.stringContaining(failureMessage),
        details: {
          stage: "gemini-response-capture",
          code: "gemini-response-capture-recoverable",
          reattachable: true,
          runtime: {
            conversationId: "target-1",
            promptEpoch: {
              status: "committed",
              promptSha256: promptIdentitySha256("hello"),
              verifiedUserTurnIndex: 0,
              verifiedUserTurnId: "data-message-id:user-current",
              verifiedUserMessageId: "data-message-id:user-current",
              conversationId: "target-1",
            },
            recoveryCleanupResult: { status: "pending" },
            recoveryCleanupResources: [
              expect.objectContaining({
                chromeTargetId: "target-1",
                targetCloseCapability: expect.objectContaining({
                  version: 1,
                  generationId: expect.any(String),
                  capabilityId: expect.any(String),
                }),
                conversationId: "target-1",
                promptEpoch: expect.objectContaining({ status: "committed" }),
                recoveryCleanup: expect.objectContaining({ ownsTarget: true }),
              }),
            ],
          },
        },
      });

      const committed = persisted.find((runtime) => runtime.promptEpoch?.status === "committed");
      expect(committed).toMatchObject({
        conversationId: "target-1",
        promptEpoch: expect.objectContaining({
          status: "committed",
          promptSha256: promptIdentitySha256("hello"),
        }),
      });
      expect(events.indexOf("persist:pending:unbound")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("persist:committed:unbound")).toBeGreaterThan(
        events.indexOf("persist:pending:unbound"),
      );
      expect(events).not.toContain("persist:committed:abort");
      expect(closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
      expect(killChrome).not.toHaveBeenCalled();
    },
  );

  it("preserves an accepted provider-id-less Gemini turn without advertising exact reattach", async () => {
    const evaluateNormally = runtimeEvaluate.getMockImplementation();
    if (!evaluateNormally) throw new Error("missing Gemini Runtime.evaluate fixture");
    runtimeEvaluate.mockImplementation(async (input: { expression?: string }) => {
      const source = String(input.expression ?? "");
      if (source.includes("beforeUserCount")) {
        return {
          result: {
            value: JSON.stringify({
              userQueryCount: 0,
              responseCount: 0,
              sendResult: "clicked",
              bindingStatus: "accepted",
              userStableId: null,
            }),
          },
        };
      }
      if (source.includes("const ordered =")) {
        throw new Error("injected accepted-turn response failure");
      }
      return evaluateNormally(input);
    });
    const promptSha256 = promptIdentitySha256("hello");
    const verifiedUserTurnId = `gemini-dom-turn:0:${promptSha256}`;
    const exec = createGeminiWebExecutor({});

    await expect(
      exec({
        prompt: "hello",
        attachments: [],
        config: { desiredModel: "gemini-3-deep-think", keepBrowser: false },
        log: () => {},
      }),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: {
        code: "gemini-reattach-authority-unavailable",
        reattachable: false,
        runtime: {
          promptEpoch: {
            status: "committed",
            promptSha256,
            verifiedUserTurnIndex: 0,
            verifiedUserTurnId,
            verifiedUserMessageId: verifiedUserTurnId,
            conversationId: "target-1",
          },
        },
      },
    });
    expect(
      runtimeEvaluate.mock.calls.some(([input]) =>
        String(input.expression ?? "").includes("const ordered ="),
      ),
    ).toBe(false);
    expect(closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
    expect(killChrome).not.toHaveBeenCalled();
  });

  it("rejects Chrome evaluation exceptions and cleans up the unpublished session", async () => {
    runtimeEvaluate.mockResolvedValueOnce({
      result: { type: "object", subtype: "error" },
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "ReferenceError: visibleSpinners is not defined" },
      },
    });
    const exec = createGeminiWebExecutor({});

    await expect(
      exec({
        prompt: "hello",
        attachments: [],
        config: { desiredModel: "gemini-3-deep-think", keepBrowser: false },
        log: () => {},
      }),
    ).rejects.toThrow(
      "Gemini Deep Think DOM evaluation failed: ReferenceError: visibleSpinners is not defined",
    );
    expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledTimes(1);
    expect(killChrome).toHaveBeenCalledTimes(1);
  });
  it.each([
    { first: "finalize" as const, second: "finalize" as const },
    { first: "abort" as const, second: "abort" as const },
    { first: "finalize" as const, second: "abort" as const },
    { first: "abort" as const, second: "finalize" as const },
  ])("settles HTTP Gemini transactions $first→$second", async ({ first, second }) => {
    const exec = createGeminiWebExecutor({});
    const transaction = await exec({
      prompt: "hello",
      attachments: [],
      config: { desiredModel: "gemini-3-pro" },
      log: () => {},
    });

    const settled = await transaction[first]();
    if (first === second) {
      await expect(transaction[second]()).resolves.toBe(settled);
    } else {
      await expect(transaction[second]()).rejects.toMatchObject({
        details: {
          code: "browser-run-lifecycle-settlement-conflict",
          requestedMode: second,
          boundMode: first,
        },
      });
    }
    expect(closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
    expect(killChrome).not.toHaveBeenCalled();
  });

  it("binds abort mode and rejects later finalize without duplicate teardown", async () => {
    const exec = createGeminiWebExecutor({});
    const result = await exec({
      prompt: "hello",
      attachments: [],
      config: { desiredModel: "gemini-3-deep-think", keepBrowser: false },
      log: () => {},
    });

    expect(closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
    await expect(result.abort()).resolves.toMatchObject({ status: "completed" });
    await expect(result.finalize()).rejects.toMatchObject({
      details: {
        code: "browser-run-lifecycle-settlement-conflict",
        requestedMode: "finalize",
        boundMode: "abort",
      },
    });
    expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledTimes(1);
    expect(killChrome).toHaveBeenCalledTimes(1);
  });

  it("retries cleanup only through the bound finalizer when teardown is temporarily unsafe", async () => {
    killChrome
      .mockResolvedValueOnce({ status: "unsafe", pid: 12345, reason: "termination failed" })
      .mockResolvedValueOnce({ status: "stopped", pid: 12345, signal: "CONTROL_CHANNEL" });
    teardownSettle
      .mockImplementationOnce(async (teardown: () => Promise<boolean>) => {
        teardownState.leaseReleased = true;
        expect(await teardown()).toBe(false);
        return { status: "preserved", reason: "teardown-unsafe" };
      })
      .mockImplementationOnce(async () => ({ status: "preserved", reason: "active-leases" }))
      .mockImplementationOnce(async (teardown: () => Promise<boolean>) => {
        expect(await teardown()).toBe(true);
        return { status: "completed", disposition: "teardown-completed" };
      });
    const exec = createGeminiWebExecutor({});

    const result = await exec({
      prompt: "hello",
      attachments: [],
      config: { desiredModel: "gemini-3-deep-think", keepBrowser: false },
      log: () => {},
    });

    expect(result.runtime.recoveryCleanupResult).toEqual({ status: "pending" });
    expect(killChrome).not.toHaveBeenCalled();

    const first = await result.finalize();
    expect(first).toMatchObject({ status: "pending" });
    expect(killChrome).toHaveBeenCalledTimes(1);

    await expect(result.finalize()).resolves.toMatchObject({ status: "pending" });
    expect(killChrome).toHaveBeenCalledTimes(1);

    await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
    expect(killChrome).toHaveBeenCalledTimes(2);
    expect(cleanupStaleProfileState).toHaveBeenCalledTimes(1);
  });

  it("falls back to HTTP/header path for gemini deep-think when attachments are present", async () => {
    const exec = createGeminiWebExecutor({});
    await exec({
      prompt: "summarize this file",
      attachments: [{ path: "/tmp/attach.txt", displayPath: "attach.txt" }],
      config: { desiredModel: "gemini-3-deep-think", chromeProfile: "Default" },
      log: () => {},
    });

    expect(getCookies).toHaveBeenCalled();
    expect(runGeminiWebWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-3-pro-deep-think",
        files: ["/tmp/attach.txt"],
      }),
    );
  });

  it("keeps the launched browser alive when Deep Think uses the keep-browser default", async () => {
    const exec = createGeminiWebExecutor({});
    const result = await exec({
      prompt: "hello",
      attachments: [],
      config: { desiredModel: "gemini-3-deep-think" },
      log: () => {},
    });

    expect(settleManualChromeOwner).not.toHaveBeenCalled();
    expect(closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
    await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
    expect(settleManualChromeOwner).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ disposition: "preserve" }),
      expect.any(Function),
    );
    expect(closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
    expect(targetCloseAuthorityTest.retainedTargetCloseAuthorityCount()).toBe(0);
    expect(killChrome).not.toHaveBeenCalled();
  });
});
