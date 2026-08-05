import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import type {
  OracleChromeOwnerRecord,
  RecordedChromeTerminationOutcome,
} from "../../src/browser/profileState.js";
import { createGeminiWebExecutor } from "../../src/gemini-web/executor.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import { promptIdentitySha256 } from "../../src/browser/actions/promptComposer.js";

const {
  launchChrome,
  connectWithNewTab,
  closeTab,
  killChrome,
  resolveBrowserConfig,
  readDevToolsPort,
  writeOracleChromeOwner,
  cleanupStaleProfileState,
  verifyDevToolsReachable,
  delay,
  captureProfileDirectoryIdentity,
  acquireManualChromeOwner,
  acquireBrowserTabLease,
  retainBrowserTabLeaseTeardownAuthority,
  teardownSettle,
  teardownState,
} = vi.hoisted(() => ({
  launchChrome: vi.fn(),
  connectWithNewTab: vi.fn(),
  closeTab: vi.fn(async () => true),
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
  cleanupStaleProfileState: vi.fn(async () => true),
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
  connectWithNewTab,
  closeTab,
}));
vi.mock("../../src/browser/config.js", () => ({
  resolveBrowserConfig,
}));
vi.mock("../../src/browser/profileState.js", () => ({
  captureProfileDirectoryIdentity,
  cleanupStaleProfileState,
  isSafeChromeTerminationOutcome: (outcome: { status?: string }) =>
    outcome.status === "stopped" || outcome.status === "already-stopped",
  readDevToolsPort,
  writeOracleChromeOwner,
  verifyDevToolsReachable,
}));
vi.mock("../../src/browser/manualChromeOwner.js", () => ({
  acquireManualChromeOwner,
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
    runGeminiWebWithFallback.mockClear();
    saveFirstGeminiImageFromOutput.mockClear();
    getCookies.mockClear();
    launchChrome.mockReset();
    connectWithNewTab.mockReset();
    closeTab.mockClear();
    resolveBrowserConfig.mockClear();
    readDevToolsPort.mockReset();
    writeOracleChromeOwner.mockClear();
    cleanupStaleProfileState.mockClear();
    verifyDevToolsReachable.mockReset();
    delay.mockClear();
    killChrome.mockClear();
    captureProfileDirectoryIdentity.mockClear();
    acquireManualChromeOwner.mockReset();
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
    acquireManualChromeOwner.mockImplementation(async (profileDir: string, config, logger) => {
      const profileDirectory = await captureProfileDirectoryIdentity(profileDir, { create: true });
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
      };
      await writeOracleChromeOwner(profileDir, ownerRecord);
      return {
        chrome: { ...chrome, processIdentity: ownerRecord.processIdentity },
        processIdentity: ownerRecord.processIdentity,
        source: "launched" as const,
      };
    });
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
    connectWithNewTab.mockResolvedValue({
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
    closeTab.mockImplementationOnce(async () => {
      events.push("close-target");
      return true;
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
    expect(connectWithNewTab).toHaveBeenCalled();
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
    expect(closeTab).not.toHaveBeenCalled();
    expect(killChrome).not.toHaveBeenCalled();
    expect(events).toEqual(["persist:acquired", "persist:pending", "persist:committed"]);
    expect(runtimeEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({ awaitPromise: true, returnByValue: true }),
    );

    await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
    expect(events).toEqual([
      "persist:acquired",
      "persist:pending",
      "persist:committed",
      "persist:committed:finalize",
      "close-target",
    ]);
    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(killChrome).toHaveBeenCalledTimes(1);
  });

  it("persists exact prompt and cleanup authority before a post-binding response failure", async () => {
    const persisted: BrowserRuntimeMetadata[] = [];
    const events: string[] = [];
    const evaluateNormally = runtimeEvaluate.getMockImplementation();
    if (!evaluateNormally) throw new Error("missing Gemini Runtime.evaluate fixture");
    runtimeEvaluate.mockImplementation(async (input: { expression?: string }) => {
      if (String(input.expression ?? "").includes("const ordered =")) {
        throw new Error("injected response polling failure");
      }
      return evaluateNormally(input);
    });
    closeTab.mockImplementationOnce(async () => {
      events.push("close-target");
      return true;
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
    ).rejects.toThrow("injected response polling failure");

    const committed = persisted.find((runtime) => runtime.promptEpoch?.status === "committed");
    expect(committed).toMatchObject({
      conversationId: "target-1",
      promptEpoch: {
        status: "committed",
        promptSha256: promptIdentitySha256("hello"),
        verifiedUserTurnIndex: 0,
        verifiedUserTurnId: "data-message-id:user-current",
        verifiedUserMessageId: "data-message-id:user-current",
        conversationId: "target-1",
      },
      recoveryCleanupResources: [
        expect.objectContaining({
          chromeTargetId: "target-1",
          conversationId: "target-1",
          promptEpoch: expect.objectContaining({ status: "committed" }),
        }),
      ],
    });
    expect(events).toEqual([
      "persist:acquired:unbound",
      "persist:pending:unbound",
      "persist:committed:unbound",
      "persist:committed:finalize",
      "close-target",
    ]);
    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(killChrome).toHaveBeenCalledTimes(1);
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
    expect(closeTab).toHaveBeenCalled();
  });

  it("binds abort authority when capture persistence and abort persistence both fail", async () => {
    const exec = createGeminiWebExecutor({});

    await expect(
      exec({
        prompt: "hello",
        attachments: [],
        config: { desiredModel: "Gemini 3 Pro", manualLogin: true, keepBrowser: false },
        runtimeHintCb: async () => {
          throw new Error("session store unavailable");
        },
        log: () => {},
      }),
    ).rejects.toMatchObject({
      details: {
        code: "gemini-browser-runtime-persistence-failed",
        runtime: {
          recoveryCleanupResult: {
            status: "failed",
            error: "session store unavailable",
            settlementMode: "abort",
          },
          recoveryCleanupResources: [expect.objectContaining({ chromeTargetId: "target-1" })],
        },
      },
    });
    expect(closeTab).not.toHaveBeenCalled();
    expect(killChrome).not.toHaveBeenCalled();
  });

  it("aborts unpublished browser resources when retrying abort persistence succeeds", async () => {
    const runtimeHintCb = vi
      .fn(async (_runtime: BrowserRuntimeMetadata) => undefined)
      .mockRejectedValueOnce(new Error("session store unavailable"));
    const exec = createGeminiWebExecutor({});

    await expect(
      exec({
        prompt: "hello",
        attachments: [],
        config: { desiredModel: "Gemini 3 Pro", manualLogin: true, keepBrowser: false },
        runtimeHintCb,
        log: () => {},
      }),
    ).rejects.toMatchObject({
      details: {
        code: "gemini-browser-runtime-persistence-failed",
      },
    });
    expect(runtimeHintCb).toHaveBeenCalledTimes(2);
    expect(runtimeHintCb).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        recoveryCleanupResult: { status: "pending", settlementMode: "abort" },
      }),
    );
    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(killChrome).toHaveBeenCalledTimes(1);
  });

  it("binds abort mode and rejects later finalize without duplicate teardown", async () => {
    const exec = createGeminiWebExecutor({});
    const result = await exec({
      prompt: "hello",
      attachments: [],
      config: { desiredModel: "gemini-3-deep-think", keepBrowser: false },
      log: () => {},
    });

    expect(closeTab).not.toHaveBeenCalled();
    await expect(result.abort()).resolves.toMatchObject({ status: "completed" });
    await expect(result.finalize()).rejects.toMatchObject({
      details: {
        code: "browser-run-lifecycle-settlement-conflict",
        requestedMode: "finalize",
        boundMode: "abort",
      },
    });
    expect(closeTab).toHaveBeenCalledTimes(1);
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

    expect(closeTab).not.toHaveBeenCalled();
    await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
    expect(closeTab).toHaveBeenCalledWith(9222, "target-1", expect.any(Function), "127.0.0.1");
    expect(killChrome).not.toHaveBeenCalled();
  });
});
