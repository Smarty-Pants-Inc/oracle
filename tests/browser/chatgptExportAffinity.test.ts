import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test as it, vi } from "vitest";
import type { ChromeClient } from "../../src/browser/types.js";
import type * as LiveTabs from "../../src/browser/liveTabs.js";

const liveTabMocks = vi.hoisted(() => ({
  connectToExistingChatGptTab: vi.fn(),
  openChatGptTarget: vi.fn(),
}));

const lifecycleMocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  connectToRemoteChromeTarget: vi.fn(),
}));

const archiveMocks = vi.hoisted(() => ({
  archiveChatGptConversation: vi.fn(),
}));

vi.mock("../../src/browser/liveTabs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof LiveTabs>();
  return {
    ...actual,
    DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
    DEFAULT_REMOTE_CHROME_PORT: 9222,
    ...liveTabMocks,
  };
});

vi.mock("../../src/browser/chromeLifecycle.js", () => lifecycleMocks);
vi.mock("../../src/browser/actions/archiveConversation.js", () => archiveMocks);

import {
  captureApprovedChatGptConversationBackend,
  conversationIdFromChatGptUrl,
} from "../../src/browser/chatgptExport.js";

describe("ChatGPT export account receipt", () => {
  const temporaryDirectories: string[] = [];

  async function freshOutputDir(prefix: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), prefix));
    temporaryDirectories.push(root);
    return path.join(root, "bundle");
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    liveTabMocks.connectToExistingChatGptTab.mockReset();
    liveTabMocks.openChatGptTarget.mockReset();
    lifecycleMocks.closeTab.mockReset();
    lifecycleMocks.connectToRemoteChromeTarget.mockReset();
    archiveMocks.archiveChatGptConversation.mockReset();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });
  it.each([
    "https://chatgpt.com.evil.example/c/conv-1",
    "https://chatgpt.com@evil.example/c/conv-1",
    "https://chatgpt.com:443/c/conv-1",
    "https://chatgpt.com/c/conv-1?next=https://evil.example",
    "https://chatgpt.com/c/conv-1#https://evil.example",
    "https://evil.example/redirect?to=https://chatgpt.com/c/conv-1",
  ])("rejects a spoofed or redirect-bearing approved URL %s", (url) => {
    expect(() => conversationIdFromChatGptUrl(url)).toThrow(/target-url/i);
  });
  const test = process.platform === "win32" ? it.skip : it;

  test("keeps the verified account digest internal and honors explicit post-export archiving", async () => {
    const outDir = await freshOutputDir("oracle-chatgpt-export-affinity-");
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    const rawText = JSON.stringify({
      title: "Receipt",
      conversation_id: "conv-1",
      current_node: null,
      mapping: {},
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    const cleanupOrder: string[] = [];
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (
          expression.includes("/api/auth/session") &&
          !expression.includes('kind: "authenticated-exact-get"')
        ) {
          return {
            result: { value: { accountDigest, email: "owner@example.test" } },
          };
        }
        if (expression === "location.href" || expression.includes('typeof location === "object"')) {
          return { result: { value: "https://chatgpt.com/c/conv-1" } };
        }
        if (expression.includes("const summaries =")) {
          return {
            result: {
              value: {
                href: "https://chatgpt.com/c/conv-1",
                title: "Receipt",
                hit: {
                  url: "https://chatgpt.com/backend-api/conversation/conv-1",
                  status: 200,
                  chars: rawText.length,
                  conversation_id: "conv-1",
                },
                hits: [],
              },
            },
          };
        }
        if (expression.includes("String(text).slice")) {
          return { result: { value: rawText } };
        }
        if (expression.includes("sessionStorage.removeItem")) {
          cleanupOrder.push("cleanup");
          return { result: { value: true } };
        }
        throw new Error(`Unexpected Runtime.evaluate expression: ${expression.slice(0, 80)}`);
      }),
    } as unknown as ChromeClient["Runtime"];
    const close = vi.fn(async () => undefined);
    const removeScriptToEvaluateOnNewDocument = vi.fn(async () => {
      cleanupOrder.push("remove-script");
    });
    const Page = {
      addScriptToEvaluateOnNewDocument: vi.fn(async () => ({ identifier: "capture-hook" })),
      removeScriptToEvaluateOnNewDocument,
      enable: vi.fn(async () => ({})),
      reload: vi.fn(async () => ({})),
    };
    archiveMocks.archiveChatGptConversation.mockResolvedValue({ attempted: true, archived: true });
    liveTabMocks.connectToExistingChatGptTab.mockResolvedValue({
      client: { Runtime, Page, close },
      targetId: "target-1",
      tab: {
        targetId: "target-1",
        type: "page",
        title: "Receipt",
        url: "https://chatgpt.com/c/conv-1",
      },
    });

    const result = await captureApprovedChatGptConversationBackend({
      targetUrl: "https://chatgpt.com/c/conv-1",
      outDir,
      host: "127.0.0.1",
      port: 9223,
      browserId: "browser-a",
      browserWSEndpoint,
      accountDigest,
      expectedEmail: "owner@example.test",
      archiveAfterExport: true,
    });

    expect(result).toMatchObject({
      ok: true,
      conversationId: "conv-1",
      archiveRecovery: { attempted: false, recovered: false, status: "not-needed" },
      postExportArchive: { attempted: true, archived: true },
    });
    expect(result).not.toHaveProperty("accountDigest");
    expect(close).toHaveBeenCalledOnce();
    expect(removeScriptToEvaluateOnNewDocument).toHaveBeenCalledWith({
      identifier: "capture-hook",
    });
    expect(cleanupOrder).toEqual(["remove-script", "cleanup"]);
    expect(archiveMocks.archiveChatGptConversation).toHaveBeenCalledOnce();
    const archiveOptions = archiveMocks.archiveChatGptConversation.mock.calls[0]?.[2];
    expect(archiveOptions).toMatchObject({ remainingMs: expect.any(Number) });
    expect(archiveOptions).not.toHaveProperty("deadline");
    expect(liveTabMocks.openChatGptTarget).not.toHaveBeenCalled();
  });

  test("removes capture hooks, raw state, and registration after capture failure", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-export-hook-failure-"));
    temporaryDirectories.push(outDir);
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    const secret = "raw-body-preview";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    let cleanupEvaluated = false;
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (
          expression.includes("/api/auth/session") &&
          !expression.includes('kind: "authenticated-exact-get"')
        ) {
          return {
            result: { value: { accountDigest, email: "owner@example.test" } },
          };
        }
        if (expression === "location.href" || expression.includes('typeof location === "object"')) {
          return { result: { value: "https://chatgpt.com/c/conv-1" } };
        }
        if (expression.includes("const summaries =")) {
          return {
            result: {
              value: {
                href: "https://chatgpt.com/c/conv-1",
                hit: null,
                hits: [{ status: 500, bodyPreview: secret, text: secret }],
              },
            },
          };
        }
        if (expression.includes("sessionStorage.removeItem")) {
          cleanupEvaluated = true;
          return { result: { value: true } };
        }
        throw new Error(`Unexpected Runtime.evaluate expression: ${expression.slice(0, 80)}`);
      }),
    } as unknown as ChromeClient["Runtime"];
    const removeScriptToEvaluateOnNewDocument = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    liveTabMocks.connectToExistingChatGptTab.mockResolvedValue({
      client: {
        Runtime,
        Page: {
          addScriptToEvaluateOnNewDocument: vi.fn(async () => ({ identifier: "capture-hook" })),
          removeScriptToEvaluateOnNewDocument,
          enable: vi.fn(async () => ({})),
          reload: vi.fn(async () => ({})),
        },
        close,
      },
      targetId: "target-1",
      tab: {
        targetId: "target-1",
        type: "page",
        title: "Receipt",
        url: "https://chatgpt.com/c/conv-1",
      },
    });

    const failure = await captureApprovedChatGptConversationBackend({
      targetUrl: "https://chatgpt.com/c/conv-1",
      outDir,
      host: "127.0.0.1",
      port: 9223,
      browserId: "browser-a",
      browserWSEndpoint,
      accountDigest,
      expectedEmail: "owner@example.test",
      archiveAfterExport: true,
      timeoutMs: 100,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /timed out waiting for backend conversation capture/i,
    );
    expect((failure as Error).message).not.toContain(secret);

    expect(cleanupEvaluated).toBe(true);
    expect(removeScriptToEvaluateOnNewDocument).toHaveBeenCalledWith({
      identifier: "capture-hook",
    });
    expect(close).toHaveBeenCalledOnce();
    expect(archiveMocks.archiveChatGptConversation).not.toHaveBeenCalled();
  });

  test("cleans the current document when Page.enable fails after hook registration", async () => {
    const outDir = await freshOutputDir("oracle-chatgpt-export-enable-failure-");
    const accountDigest = "a".repeat(64);
    const events: string[] = [];
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("/api/auth/session")) {
          return { result: { value: { accountDigest, email: "owner@example.test" } } };
        }
        if (expression.includes('typeof location === "object"')) {
          return { result: { value: "https://chatgpt.com/c/conv-1" } };
        }
        if (expression.includes("sessionStorage.removeItem")) {
          events.push("cleanup");
          return { result: { value: true } };
        }
        throw new Error(`Unexpected Runtime.evaluate expression: ${expression.slice(0, 80)}`);
      }),
    } as unknown as ChromeClient["Runtime"];
    const removeScriptToEvaluateOnNewDocument = vi.fn(async () => {
      events.push("remove-script");
    });
    const reload = vi.fn(async () => ({}));
    const close = vi.fn(async () => undefined);
    liveTabMocks.connectToExistingChatGptTab.mockResolvedValue({
      client: {
        Runtime,
        Page: {
          addScriptToEvaluateOnNewDocument: vi.fn(async () => {
            events.push("register-hook");
            return { identifier: "capture-hook" };
          }),
          removeScriptToEvaluateOnNewDocument,
          enable: vi.fn(async () => {
            events.push("enable-after-external-reload");
            throw new Error("Page.enable failed after external reload");
          }),
          reload,
        },
        close,
      },
      targetId: "target-1",
      tab: {
        targetId: "target-1",
        type: "page",
        title: "Receipt",
        url: "https://chatgpt.com/c/conv-1",
      },
    });

    await expect(
      captureApprovedChatGptConversationBackend({
        targetUrl: "https://chatgpt.com/c/conv-1",
        outDir,
      }),
    ).rejects.toThrow(/Page\.enable failed after external reload/i);

    expect(events).toEqual([
      "register-hook",
      "enable-after-external-reload",
      "remove-script",
      "cleanup",
    ]);
    expect(reload).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  test("exports a known-active conversation by exact GET without changing archive state", async () => {
    const outDir = await freshOutputDir("oracle-chatgpt-export-active-");
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-active";
    const rawText = JSON.stringify({
      title: "Active receipt",
      conversation_id: "conv-active",
      current_node: null,
      mapping: {},
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    const evaluatedExpressions: string[] = [];
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        evaluatedExpressions.push(expression);
        if (expression === "document.readyState") return { result: { value: "complete" } };
        if (expression === "location.href" || expression.includes('typeof location === "object"')) {
          return { result: { value: "https://chatgpt.com/" } };
        }
        if (expression === "document.title") return { result: { value: "ChatGPT" } };
        if (
          expression.includes("/api/auth/session") &&
          !expression.includes('kind: "authenticated-exact-get"')
        ) {
          return {
            result: { value: { accountDigest, email: "owner@example.test" } },
          };
        }
        if (expression.includes('kind: "authenticated-exact-get"')) {
          return {
            result: {
              value: {
                kind: "authenticated-exact-get",
                url: targetApiUrl,
                status: 200,
                ok: true,
                contentType: "application/json",
                chars: rawText.length,
                conversation_id: "conv-active",
              },
            },
          };
        }
        if (expression.includes("String(text).slice")) {
          return { result: { value: rawText } };
        }
        if (expression.includes("sessionStorage.removeItem")) {
          return { result: { value: true } };
        }
        throw new Error(`Unexpected Runtime.evaluate expression: ${expression.slice(0, 80)}`);
      }),
    } as unknown as ChromeClient["Runtime"];
    const Page = { enable: vi.fn(async () => ({})) };
    const close = vi.fn(async () => undefined);
    lifecycleMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: { Runtime, Page },
      targetId: "target-active",
      browserWSEndpoint,
      close,
    });

    const result = await captureApprovedChatGptConversationBackend({
      targetUrl: "https://chatgpt.com/c/conv-active",
      outDir,
      host: "127.0.0.1",
      port: 9223,
      browserId: "browser-a",
      browserWSEndpoint,
      accountDigest,
      expectedEmail: "owner@example.test",
      knownArchived: false,
    });

    expect(result).toMatchObject({
      ok: true,
      conversationId: "conv-active",
      archiveRecovery: {
        attempted: false,
        recovered: false,
        status: "read-only",
        getStatus: 200,
        archiveStatePreserved: true,
      },
    });
    expect(result).not.toHaveProperty("accountDigest");
    const payload = JSON.parse(await fs.readFile(result.payloadPath, "utf8"));
    const markdown = await fs.readFile(result.markdownPath, "utf8");
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    expect(payload).toMatchObject({
      capture_route: "authenticated-affinity-bound-exact-get",
      extraction_method: "authenticated-affinity-bound-exact-get",
      backend_probe: { method: "authenticated-affinity-bound-exact-get" },
    });
    expect(markdown).toContain("- Capture route: authenticated-affinity-bound-exact-get");
    expect(manifest).toMatchObject({
      capture_route: "authenticated-affinity-bound-exact-get",
      extraction_method: "authenticated-affinity-bound-exact-get",
      backend_probe: { method: "authenticated-affinity-bound-exact-get" },
    });
    expect(`${JSON.stringify(payload)}\n${markdown}\n${JSON.stringify(manifest)}`).not.toContain(
      "document_start_fetch_clone_on_reload",
    );
    const exactGetExpressions = evaluatedExpressions.filter((expression) =>
      expression.includes('kind: "authenticated-exact-get"'),
    );
    expect(exactGetExpressions).toHaveLength(1);
    expect(exactGetExpressions[0]).toContain(`const EXPECTED_ACCOUNT_DIGEST = "${accountDigest}"`);
    expect(exactGetExpressions[0]).toContain('const EXPECTED_EMAIL = "owner@example.test"');
    expect(lifecycleMocks.connectToRemoteChromeTarget).toHaveBeenCalledWith(
      "127.0.0.1",
      9223,
      expect.any(Function),
      {
        browserWSEndpoint,
        targetUrl: "https://chatgpt.com/",
        closeTargetOnDispose: true,
      },
    );
    expect(liveTabMocks.connectToExistingChatGptTab).not.toHaveBeenCalled();
    expect(liveTabMocks.openChatGptTarget).not.toHaveBeenCalled();
    expect(archiveMocks.archiveChatGptConversation).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  test("uses the remaining export deadline for a stalled exact GET and still cleans up", async () => {
    const outDir = await freshOutputDir("oracle-chatgpt-export-timeout-");
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    const events: string[] = [];
    let exactGetExpression = "";
    let documentChecks = 0;
    let signalExactGetStarted: () => void;
    const exactGetStarted = new Promise<void>((resolve) => {
      signalExactGetStarted = resolve;
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    const Runtime = {
      evaluate: vi.fn(({ expression }: { expression: string }) => {
        if (expression === "document.readyState") {
          documentChecks += 1;
          return Promise.resolve({
            result: { value: documentChecks === 1 ? "loading" : "complete" },
          });
        }
        if (expression === "location.href" || expression.includes('typeof location === "object"')) {
          return Promise.resolve({ result: { value: "https://chatgpt.com/" } });
        }
        if (expression === "document.title") {
          return Promise.resolve({ result: { value: "ChatGPT" } });
        }
        if (expression.includes('kind: "authenticated-exact-get"')) {
          exactGetExpression = expression;
          signalExactGetStarted();
          return new Promise<never>(() => undefined);
        }
        if (expression.includes("/api/auth/session")) {
          return Promise.resolve({
            result: { value: { accountDigest, email: "owner@example.test" } },
          });
        }
        if (expression.includes("sessionStorage.removeItem")) {
          events.push("cleanup");
          return Promise.resolve({ result: { value: true } });
        }
        throw new Error(`Unexpected Runtime.evaluate expression: ${expression.slice(0, 80)}`);
      }),
    } as unknown as ChromeClient["Runtime"];
    const close = vi.fn(async () => {
      events.push("close");
    });
    lifecycleMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: { Runtime, Page: { enable: vi.fn(async () => undefined) } },
      targetId: "target-timeout",
      browserWSEndpoint,
      close,
    });

    const capture = captureApprovedChatGptConversationBackend({
      targetUrl: "https://chatgpt.com/c/conv-active",
      outDir,
      host: "127.0.0.1",
      port: 9223,
      browserId: "browser-a",
      browserWSEndpoint,
      accountDigest,
      expectedEmail: "owner@example.test",
      knownArchived: false,
      timeoutMs: 250,
    });
    const captureFailure = capture.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(100);
    await exactGetStarted;
    expect(exactGetExpression).toContain("const REMAINING_MS = 150");
    expect(exactGetExpression).toContain("const DEADLINE = Date.now() + REMAINING_MS");
    expect(exactGetExpression).toContain(
      'const SESSION_TARGET = "https://chatgpt.com/api/auth/session"',
    );
    expect(exactGetExpression).toContain("requestWithinDeadline(\n    SESSION_TARGET,");
    expect(exactGetExpression).toContain(
      "sessionResponse.redirected || sessionResponse.url !== SESSION_TARGET",
    );
    expect(exactGetExpression).toContain("requestWithinDeadline(\n    TARGET,");
    expect(exactGetExpression).toContain("signal: controller.signal");

    await vi.advanceTimersByTimeAsync(150);
    const failure = await captureFailure;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /timed out waiting for authenticated ChatGPT exact GET/i,
    );
    expect(documentChecks).toBe(2);
    expect(events).toEqual(["cleanup", "close"]);
  });

  test("bounds a stalled browser identity probe before CDP setup", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<never>(() => undefined)),
    );

    const failure = captureApprovedChatGptConversationBackend({
      targetUrl: "https://chatgpt.com/c/conv-identity-stall",
      outDir: "/tmp/oracle-chatgpt-export-identity-stall",
      host: "127.0.0.1",
      port: 9223,
      browserId: "browser-a",
      browserWSEndpoint,
      accountDigest: "a".repeat(64),
      knownArchived: true,
      timeoutMs: 250,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(250);

    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/timed out resolving Remote Chrome browser identity/i);
    expect(lifecycleMocks.connectToRemoteChromeTarget).not.toHaveBeenCalled();
  });

  test("bounds a stalled disposable target connection before document setup", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    let resolveLateConnection!: (connection: {
      client: ChromeClient;
      targetId: string;
      browserWSEndpoint: string;
      close: () => Promise<void>;
    }) => void;
    const lateClose = vi.fn(async () => undefined);
    lifecycleMocks.connectToRemoteChromeTarget.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLateConnection = resolve;
        }),
    );

    const failure = captureApprovedChatGptConversationBackend({
      targetUrl: "https://chatgpt.com/c/conv-connect-stall",
      outDir: "/tmp/oracle-chatgpt-export-connect-stall",
      host: "127.0.0.1",
      port: 9223,
      browserId: "browser-a",
      browserWSEndpoint,
      accountDigest: "a".repeat(64),
      knownArchived: true,
      timeoutMs: 250,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(250);

    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /timed out connecting to the read-only ChatGPT export target/i,
    );
    expect(lifecycleMocks.connectToRemoteChromeTarget).toHaveBeenCalledOnce();

    resolveLateConnection({
      client: {} as ChromeClient,
      targetId: "target-late",
      browserWSEndpoint,
      close: lateClose,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(lateClose).toHaveBeenCalledOnce();
  });

  test("bounds a stalled owned-target close to the cleanup allowance", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    let signalExactGetStarted: () => void;
    const exactGetStarted = new Promise<void>((resolve) => {
      signalExactGetStarted = resolve;
    });
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    const Runtime = {
      evaluate: vi.fn(({ expression }: { expression: string }) => {
        if (expression === "document.readyState")
          return Promise.resolve({ result: { value: "complete" } });
        if (expression === "location.href" || expression.includes('typeof location === "object"')) {
          return Promise.resolve({ result: { value: "https://chatgpt.com/" } });
        }
        if (expression === "document.title")
          return Promise.resolve({ result: { value: "ChatGPT" } });
        if (expression.includes('kind: "authenticated-exact-get"')) {
          signalExactGetStarted();
          return new Promise<never>(() => undefined);
        }
        if (expression.includes("/api/auth/session")) {
          return Promise.resolve({
            result: { value: { accountDigest, email: "owner@example.test" } },
          });
        }
        if (expression.includes("sessionStorage.removeItem")) {
          return Promise.resolve({ result: { value: true } });
        }
        throw new Error(`Unexpected Runtime.evaluate expression: ${expression.slice(0, 80)}`);
      }),
    } as unknown as ChromeClient["Runtime"];
    const close = vi.fn(() => new Promise<void>(() => undefined));
    lifecycleMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: { Runtime, Page: { enable: vi.fn(async () => undefined) } },
      targetId: "target-close-stall",
      browserWSEndpoint,
      close,
    });

    const capture = captureApprovedChatGptConversationBackend({
      targetUrl: "https://chatgpt.com/c/conv-close-stall",
      outDir: "/tmp/oracle-chatgpt-export-close-stall",
      host: "127.0.0.1",
      port: 9223,
      browserId: "browser-a",
      browserWSEndpoint,
      accountDigest,
      expectedEmail: "owner@example.test",
      knownArchived: false,
      timeoutMs: 250,
    });
    const failure = capture.catch((error: unknown) => error);

    await exactGetStarted;
    await vi.advanceTimersByTimeAsync(250);
    expect(close).toHaveBeenCalledOnce();

    let settled = false;
    void failure.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(failure).resolves.toMatchObject({
      message: "Read-only ChatGPT export and target cleanup failed.",
    });
  });

  test("cleans captured exact-GET state when the CDP result handoff fails", async () => {
    const outDir = await freshOutputDir("oracle-chatgpt-export-handoff-");
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    let cleanupEvaluated = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "document.readyState") return { result: { value: "complete" } };
        if (expression === "location.href" || expression.includes('typeof location === "object"')) {
          return { result: { value: "https://chatgpt.com/" } };
        }
        if (expression === "document.title") return { result: { value: "ChatGPT" } };
        if (
          expression.includes("/api/auth/session") &&
          !expression.includes('kind: "authenticated-exact-get"')
        ) {
          return { result: { value: { accountDigest, email: "owner@example.test" } } };
        }
        if (expression.includes('kind: "authenticated-exact-get"')) {
          throw new Error("exact GET result handoff failed");
        }
        if (expression.includes("sessionStorage.removeItem")) {
          cleanupEvaluated = true;
          return { result: { value: true } };
        }
        throw new Error(`Unexpected Runtime.evaluate expression: ${expression.slice(0, 80)}`);
      }),
    } as unknown as ChromeClient["Runtime"];
    const close = vi.fn(async () => undefined);
    lifecycleMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: { Runtime, Page: { enable: vi.fn(async () => ({})) } },
      targetId: "target-handoff",
      browserWSEndpoint,
      close,
    });

    await expect(
      captureApprovedChatGptConversationBackend({
        targetUrl: "https://chatgpt.com/c/conv-active",
        outDir,
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        browserWSEndpoint,
        accountDigest,
        expectedEmail: "owner@example.test",
        knownArchived: false,
      }),
    ).rejects.toThrow(/exact GET result handoff failed/i);

    expect(cleanupEvaluated).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  test("closes the disposable known-active target when exact-GET setup fails", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-export-cleanup-"));
    temporaryDirectories.push(outDir);
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const cleanupClose = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    lifecycleMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: {
        Runtime: {},
        Page: { enable: vi.fn().mockRejectedValue(new Error("document setup failed")) },
      },
      targetId: "target-active",
      browserWSEndpoint,
      close: cleanupClose,
    });

    await expect(
      captureApprovedChatGptConversationBackend({
        targetUrl: "https://chatgpt.com/c/conv-active",
        outDir,
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        browserWSEndpoint,
        accountDigest: "a".repeat(64),
        expectedEmail: "owner@example.test",
        knownArchived: false,
      }),
    ).rejects.toThrow(/document setup failed/i);

    expect(lifecycleMocks.connectToRemoteChromeTarget).toHaveBeenCalledWith(
      "127.0.0.1",
      9223,
      expect.any(Function),
      {
        browserWSEndpoint,
        targetUrl: "https://chatgpt.com/",
        closeTargetOnDispose: true,
      },
    );
    expect(liveTabMocks.connectToExistingChatGptTab).not.toHaveBeenCalled();
    expect(liveTabMocks.openChatGptTarget).not.toHaveBeenCalled();
    expect(cleanupClose).toHaveBeenCalledOnce();
  });

  test.each([
    {
      label: "known archived target",
      knownArchived: true,
      expectedEmail: "owner@example.test",
    },
    {
      label: "session-bound target without an expected email",
      knownArchived: undefined,
      expectedEmail: undefined,
    },
  ])(
    "exports a $label with one exact GET and no mutation",
    async ({ knownArchived, expectedEmail }) => {
      const outDir = await freshOutputDir("oracle-chatgpt-export-archived-");
      const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
      const accountDigest = "a".repeat(64);
      const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-archived";
      const rawText = JSON.stringify({
        title: "Archived receipt",
        conversation_id: "conv-archived",
        current_node: null,
        mapping: {},
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
        }),
      );
      const evaluatedExpressions: string[] = [];
      const Runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          evaluatedExpressions.push(expression);
          if (expression === "document.readyState") {
            return { result: { value: "complete" } };
          }
          if (
            expression === "location.href" ||
            expression.includes('typeof location === "object"')
          ) {
            return { result: { value: "https://chatgpt.com/" } };
          }
          if (expression === "document.title") {
            return { result: { value: "ChatGPT" } };
          }
          if (
            expression.includes("/api/auth/session") &&
            !expression.includes('kind: "authenticated-exact-get"')
          ) {
            return {
              result: {
                value: { accountDigest, email: expectedEmail ?? "owner@example.test" },
              },
            };
          }
          if (expression.includes('kind: "authenticated-exact-get"')) {
            return {
              result: {
                value: {
                  kind: "authenticated-exact-get",
                  url: targetApiUrl,
                  status: 200,
                  ok: true,
                  contentType: "application/json",
                  chars: rawText.length,
                  conversation_id: "conv-archived",
                },
              },
            };
          }
          if (expression.includes("String(text).slice")) {
            return { result: { value: rawText } };
          }
          if (expression.includes("sessionStorage.removeItem")) {
            return { result: { value: true } };
          }
          throw new Error(`Unexpected Runtime.evaluate expression: ${expression.slice(0, 80)}`);
        }),
      } as unknown as ChromeClient["Runtime"];
      const close = vi.fn(async () => undefined);
      lifecycleMocks.connectToRemoteChromeTarget.mockResolvedValue({
        client: { Runtime, Page: { enable: vi.fn(async () => ({})) } },
        targetId: "target-archived",
        browserWSEndpoint,
        close,
      });

      const result = await captureApprovedChatGptConversationBackend({
        targetUrl: "https://chatgpt.com/c/conv-archived",
        outDir,
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        browserWSEndpoint,
        accountDigest,
        expectedEmail,
        knownArchived,
      });

      expect(result).toMatchObject({
        ok: true,
        conversationId: "conv-archived",
        archiveRecovery: {
          attempted: false,
          recovered: false,
          status: "read-only",
          getStatus: 200,
          archiveStatePreserved: true,
        },
      });
      expect(result).not.toHaveProperty("accountDigest");
      expect(liveTabMocks.openChatGptTarget).not.toHaveBeenCalled();
      expect(lifecycleMocks.connectToRemoteChromeTarget).toHaveBeenCalledWith(
        "127.0.0.1",
        9223,
        expect.any(Function),
        {
          browserWSEndpoint,
          targetUrl: "https://chatgpt.com/",
          closeTargetOnDispose: true,
        },
      );
      expect(liveTabMocks.connectToExistingChatGptTab).not.toHaveBeenCalled();
      const exactGetExpressions = evaluatedExpressions.filter((expression) =>
        expression.includes('kind: "authenticated-exact-get"'),
      );
      expect(exactGetExpressions).toHaveLength(1);
      expect(exactGetExpressions[0]).toContain(
        `const EXPECTED_ACCOUNT_DIGEST = "${accountDigest}"`,
      );
      expect(exactGetExpressions[0]).toContain(
        `const EXPECTED_EMAIL = ${expectedEmail ? `"${expectedEmail}"` : "null"}`,
      );
      expect(exactGetExpressions[0]).toContain('method: "GET"');
      expect(exactGetExpressions[0]).toContain(
        'const SESSION_TARGET = "https://chatgpt.com/api/auth/session"',
      );
      expect(exactGetExpressions[0]).toContain("requestWithinDeadline(\n    SESSION_TARGET,");
      expect(exactGetExpressions[0]).toContain(
        "sessionResponse.redirected || sessionResponse.url !== SESSION_TARGET",
      );
      expect(exactGetExpressions[0]).toContain(
        'new URL(location.href).origin !== "https://chatgpt.com"',
      );
      expect(exactGetExpressions[0]).toContain(
        'headers.set("authorization", "Bearer " + accessToken)',
      );
      const exactGetIndex = evaluatedExpressions.findIndex((expression) =>
        expression.includes('kind: "authenticated-exact-get"'),
      );
      expect(evaluatedExpressions[exactGetIndex - 2]).toContain('typeof location === "object"');
      expect(evaluatedExpressions[exactGetIndex - 1]).toContain("/api/auth/session");
      expect(evaluatedExpressions[exactGetIndex + 1]).toContain('typeof location === "object"');
      expect(evaluatedExpressions[exactGetIndex + 2]).toContain("/api/auth/session");
      expect(evaluatedExpressions.join("\n")).not.toMatch(/\b(?:POST|PUT|PATCH|DELETE)\b/);
      expect(archiveMocks.archiveChatGptConversation).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      const captureInfo = JSON.parse(await fs.readFile(result.captureInfoPath, "utf8")) as {
        archive_state_preserved?: boolean;
        non_claims?: string[];
      };
      expect(captureInfo.archive_state_preserved).toBe(true);
      expect(captureInfo.non_claims?.join(" ")).toMatch(/no archive-state mutation/i);
    },
  );

  test("waits for a fresh loading target before blocking a wrong account prior to GET", async () => {
    const outDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "oracle-chatgpt-export-loading-affinity-"),
    );
    temporaryDirectories.push(outDir);
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    const evaluatedExpressions: string[] = [];
    let currentUrl = "about:blank";
    let readyChecks = 0;
    let loaded = false;
    let exactGetRan = false;
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        evaluatedExpressions.push(expression);
        if (expression === "document.readyState") {
          readyChecks += 1;
          if (readyChecks === 1) return { result: { value: "loading" } };
          currentUrl = "https://chatgpt.com/";
          loaded = true;
          return { result: { value: "complete" } };
        }
        if (expression === "location.href" || expression.includes('typeof location === "object"'))
          return { result: { value: currentUrl } };
        if (expression === "document.title") return { result: { value: "ChatGPT" } };
        if (
          expression.includes("/api/auth/session") &&
          !expression.includes('kind: "authenticated-exact-get"')
        ) {
          if (!loaded) throw new Error("account affinity was probed before document readiness");
          return {
            result: {
              value: { accountDigest: "b".repeat(64), email: "owner@example.test" },
            },
          };
        }
        if (expression.includes('kind: "authenticated-exact-get"')) {
          exactGetRan = true;
          return { result: { value: null } };
        }
        throw new Error(`Unexpected Runtime.evaluate expression: ${expression.slice(0, 80)}`);
      }),
    } as unknown as ChromeClient["Runtime"];
    const close = vi.fn(async () => undefined);
    lifecycleMocks.connectToRemoteChromeTarget.mockImplementation(async () => {
      expect(currentUrl).toBe("about:blank");
      return {
        client: { Runtime, Page: { enable: vi.fn(async () => ({})) } },
        targetId: "target-loading",
        browserWSEndpoint,
        close,
      };
    });

    await expect(
      captureApprovedChatGptConversationBackend({
        targetUrl: "https://chatgpt.com/c/conv-archived",
        outDir,
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        browserWSEndpoint,
        accountDigest,
        expectedEmail: "owner@example.test",
        knownArchived: true,
      }),
    ).rejects.toThrow(/account identity changed before ChatGPT export exact GET/i);

    expect(readyChecks).toBe(2);
    const accountCheckIndex = evaluatedExpressions.findIndex((expression) =>
      expression.includes("/api/auth/session"),
    );
    expect(accountCheckIndex).toBeGreaterThan(
      evaluatedExpressions.lastIndexOf("document.readyState"),
    );
    expect(exactGetRan).toBe(false);
    expect(liveTabMocks.connectToExistingChatGptTab).not.toHaveBeenCalled();
    expect(liveTabMocks.openChatGptTarget).not.toHaveBeenCalled();
    expect(lifecycleMocks.connectToRemoteChromeTarget).toHaveBeenCalledWith(
      "127.0.0.1",
      9223,
      expect.any(Function),
      {
        browserWSEndpoint,
        targetUrl: "https://chatgpt.com/",
        closeTargetOnDispose: true,
      },
    );
    expect(close).toHaveBeenCalledOnce();
    expect(archiveMocks.archiveChatGptConversation).not.toHaveBeenCalled();
  });

  test("blocks a post-load redirect before the exact GET or account probe", async () => {
    const outDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "oracle-chatgpt-export-redirect-affinity-"),
    );
    temporaryDirectories.push(outDir);
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    let locationReads = 0;
    let accountProbed = false;
    let exactGetRan = false;
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "document.readyState") return { result: { value: "complete" } };
        if (expression === "location.href") {
          locationReads += 1;
          return {
            result: {
              value: locationReads === 1 ? "https://chatgpt.com/" : "https://evil.example/",
            },
          };
        }
        if (expression === "document.title") return { result: { value: "Redirected" } };
        if (expression.includes('typeof location === "object"')) {
          return { result: { value: "https://evil.example/" } };
        }
        if (
          expression.includes("/api/auth/session") &&
          !expression.includes('kind: "authenticated-exact-get"')
        ) {
          accountProbed = true;
          return {
            result: { value: { accountDigest, email: "owner@example.test" } },
          };
        }
        if (expression.includes('kind: "authenticated-exact-get"')) {
          exactGetRan = true;
          return { result: { value: null } };
        }
        throw new Error(`Unexpected Runtime.evaluate expression: ${expression.slice(0, 80)}`);
      }),
    } as unknown as ChromeClient["Runtime"];
    const close = vi.fn(async () => undefined);
    lifecycleMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: { Runtime, Page: { enable: vi.fn(async () => ({})) } },
      targetId: "target-redirected",
      browserWSEndpoint,
      close,
    });

    await expect(
      captureApprovedChatGptConversationBackend({
        targetUrl: "https://chatgpt.com/c/conv-archived",
        outDir,
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        browserWSEndpoint,
        accountDigest,
        expectedEmail: "owner@example.test",
        knownArchived: true,
      }),
    ).rejects.toThrow(/left an allowed HTTPS origin before ChatGPT export exact GET/i);

    expect(locationReads).toBe(2);
    expect(accountProbed).toBe(false);
    expect(exactGetRan).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(archiveMocks.archiveChatGptConversation).not.toHaveBeenCalled();
  });

  test("blocks a known-active target redirect before account binding or exact GET", async () => {
    const outDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "oracle-chatgpt-export-navigation-redirect-"),
    );
    temporaryDirectories.push(outDir);
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    let accountProbed = false;
    let exactGetRan = false;
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "document.readyState") return { result: { value: "complete" } };
        if (expression === "location.href") {
          return { result: { value: "https://chatgpt.com/" } };
        }
        if (expression === "document.title") return { result: { value: "ChatGPT" } };
        if (expression.includes('typeof location === "object"')) {
          return { result: { value: "https://evil.example/" } };
        }
        if (
          expression.includes("/api/auth/session") &&
          !expression.includes('kind: "authenticated-exact-get"')
        ) {
          accountProbed = true;
          return {
            result: { value: { accountDigest, email: "owner@example.test" } },
          };
        }
        if (expression.includes('kind: "authenticated-exact-get"')) {
          exactGetRan = true;
          return { result: { value: null } };
        }
        throw new Error(`Unexpected Runtime.evaluate expression: ${expression.slice(0, 80)}`);
      }),
    } as unknown as ChromeClient["Runtime"];
    const close = vi.fn(async () => undefined);
    lifecycleMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: { Runtime, Page: { enable: vi.fn(async () => ({})) } },
      targetId: "target-active",
      browserWSEndpoint,
      close,
    });

    await expect(
      captureApprovedChatGptConversationBackend({
        targetUrl: "https://chatgpt.com/c/conv-active",
        outDir,
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        browserWSEndpoint,
        accountDigest,
        expectedEmail: "owner@example.test",
        knownArchived: false,
      }),
    ).rejects.toThrow(/left an allowed HTTPS origin before ChatGPT export exact GET/i);

    expect(accountProbed).toBe(false);
    expect(exactGetRan).toBe(false);
    expect(liveTabMocks.connectToExistingChatGptTab).not.toHaveBeenCalled();
    expect(liveTabMocks.openChatGptTarget).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(archiveMocks.archiveChatGptConversation).not.toHaveBeenCalled();
  });

  test("fails closed without verified affinity instead of changing archive state", async () => {
    liveTabMocks.connectToExistingChatGptTab.mockRejectedValue(new Error("target not open"));

    await expect(
      captureApprovedChatGptConversationBackend({
        targetUrl: "https://chatgpt.com/c/conv-archived",
        outDir: "/tmp/oracle-chatgpt-export-fail-closed",
        host: "127.0.0.1",
        port: 9223,
      }),
    ).rejects.toThrow(
      /read-only fallback requires stored browser and account affinity.*no archive-state changes/i,
    );

    expect(liveTabMocks.openChatGptTarget).not.toHaveBeenCalled();
    expect(archiveMocks.archiveChatGptConversation).not.toHaveBeenCalled();
  });

  test("closes a newly opened archived target when post-connection setup fails", async () => {
    const outDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "oracle-chatgpt-export-archived-setup-failure-"),
    );
    temporaryDirectories.push(outDir);
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const cleanupClose = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    lifecycleMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: {
        Runtime: {},
        Page: { enable: vi.fn().mockRejectedValue(new Error("document setup failed")) },
      },
      targetId: "target-archived",
      browserWSEndpoint,
      close: cleanupClose,
    });

    await expect(
      captureApprovedChatGptConversationBackend({
        targetUrl: "https://chatgpt.com/c/conv-archived",
        outDir,
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        browserWSEndpoint,
        accountDigest: "a".repeat(64),
        expectedEmail: "owner@example.test",
        knownArchived: true,
      }),
    ).rejects.toThrow(/document setup failed/i);

    expect(lifecycleMocks.connectToRemoteChromeTarget).toHaveBeenCalledWith(
      "127.0.0.1",
      9223,
      expect.any(Function),
      {
        browserWSEndpoint,
        targetUrl: "https://chatgpt.com/",
        closeTargetOnDispose: true,
      },
    );
    expect(cleanupClose).toHaveBeenCalledOnce();
    expect(liveTabMocks.connectToExistingChatGptTab).not.toHaveBeenCalled();
    expect(liveTabMocks.openChatGptTarget).not.toHaveBeenCalled();
    expect(archiveMocks.archiveChatGptConversation).not.toHaveBeenCalled();
  });

  test("closes the owned archived-export target when the exact GET returns the wrong id", async () => {
    const outDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "oracle-chatgpt-export-archived-failure-"),
    );
    temporaryDirectories.push(outDir);
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "document.readyState") {
          return { result: { value: "complete" } };
        }
        if (expression === "location.href" || expression.includes('typeof location === "object"')) {
          return { result: { value: "https://chatgpt.com/" } };
        }
        if (expression === "document.title") {
          return { result: { value: "ChatGPT" } };
        }
        if (
          expression.includes("/api/auth/session") &&
          !expression.includes('kind: "authenticated-exact-get"')
        ) {
          return { result: { value: { accountDigest, email: "owner@example.test" } } };
        }
        if (expression.includes('kind: "authenticated-exact-get"')) {
          return {
            result: {
              value: {
                kind: "authenticated-exact-get",
                url: "https://chatgpt.com/backend-api/conversation/conv-archived",
                status: 200,
                ok: true,
                chars: 42,
                conversation_id: "wrong-conversation",
              },
            },
          };
        }
        if (expression.includes("sessionStorage.removeItem")) {
          return { result: { value: true } };
        }
        throw new Error(`Unexpected Runtime.evaluate expression: ${expression.slice(0, 80)}`);
      }),
    } as unknown as ChromeClient["Runtime"];
    const close = vi.fn(async () => undefined);
    lifecycleMocks.connectToRemoteChromeTarget.mockResolvedValue({
      client: { Runtime, Page: { enable: vi.fn(async () => ({})) } },
      targetId: "target-archived",
      browserWSEndpoint,
      close,
    });

    await expect(
      captureApprovedChatGptConversationBackend({
        targetUrl: "https://chatgpt.com/c/conv-archived",
        outDir,
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        browserWSEndpoint,
        accountDigest,
        expectedEmail: "owner@example.test",
        knownArchived: true,
      }),
    ).rejects.toThrow(/did not return the approved conversation/i);

    expect(close).toHaveBeenCalledOnce();
    expect(archiveMocks.archiveChatGptConversation).not.toHaveBeenCalled();
  });
});
