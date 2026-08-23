import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  assertChatGptExportMutationAffinityForTest,
  backendToPayload,
  buildBackendConversationUrl,
  buildChatGptCaptureCleanupExpressionForTest,
  buildReadOnlyConversationGetExpressionForTest,
  captureApprovedChatGptConversationBackend,
  evaluateReadOnlyConversationGetForTest,
  buildScopedBackendCaptureHook,
  contentToText,
  conversationIdFromChatGptUrl,
  isSameConversationUrl,
  retrieveCapturedTextWithEvaluator,
  runBeforeExportDeadlineForTest,
  formatChatGptCaptureTimeoutForTest,
  scanTextForSecretLikeMarkers,
  writeChatGptExportBundleForTest,
} from "../../src/browser/chatgptExport.js";
const testNonWindows = process.platform === "win32" ? test.skip : test;

describe("ChatGPT conversation export helpers", () => {
  test("accepts only exact chatgpt.com conversation URLs", () => {
    expect(conversationIdFromChatGptUrl("https://chatgpt.com/c/abc-123")).toBe("abc-123");
    expect(conversationIdFromChatGptUrl("https://chatgpt.com/c/abc-123/")).toBe("abc-123");
    expect(conversationIdFromChatGptUrl("https://chatgpt.com/g/project-1/c/abc-123")).toBe(
      "abc-123",
    );
    expect(conversationIdFromChatGptUrl("https://chatgpt.com/g/g-p-123/c/abc-123/")).toBe(
      "abc-123",
    );
    expect(conversationIdFromChatGptUrl("https://chatgpt.com/g/g-p-123/project/c/abc-123")).toBe(
      "abc-123",
    );
    expect(() => conversationIdFromChatGptUrl("https://chat.openai.com/c/abc")).toThrow(
      /chatgpt\.com\/c/,
    );
    expect(() => conversationIdFromChatGptUrl("https://chatgpt.com/")).toThrow(/specific/i);
    expect(() => conversationIdFromChatGptUrl("https://chatgpt.com/g/example/project")).toThrow(
      /specific/i,
    );
  });

  test("disposes a capture-hook registration that arrives after the export deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolveLate!: (value: { identifier: string }) => void;
    const dispose = vi.fn(async () => undefined);
    try {
      const result = runBeforeExportDeadlineForTest(
        () => new Promise<{ identifier: string }>((resolve) => (resolveLate = resolve)),
        10,
        "registration timed out",
        dispose,
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      await expect(result).resolves.toMatchObject({ message: "registration timed out" });
      resolveLate({ identifier: "late-hook" });
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledWith({ identifier: "late-hook" }));
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not serialize CDP exception details from exact GET failures", async () => {
    const secret = "https://chatgpt.com/c/private-thread?token=secret";
    const runtime = {
      evaluate: vi.fn(async () => ({ exceptionDetails: { text: secret, url: secret } })),
    };
    const error = await evaluateReadOnlyConversationGetForTest(
      runtime as never,
      "https://chatgpt.com/backend-api/conversation/conv-1",
      "conv-1",
      "a".repeat(64),
      "owner@example.test",
      Date.now() + 1_000,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Read-only conversation GET failed in the page context.");
    expect((error as Error).message).not.toContain(secret);
  });

  testNonWindows("rejects a browser swap before exact export attachment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/browser-b",
        }),
      }),
    );
    try {
      await expect(
        captureApprovedChatGptConversationBackend({
          targetUrl: "https://chatgpt.com/c/conv-1",
          outDir: "/tmp/oracle-export-identity-test",
          host: "127.0.0.1",
          port: 9223,
          browserId: "browser-a",
          browserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
          accountDigest: "a".repeat(64),
        }),
      ).rejects.toThrow(/identity changed before ChatGPT export/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("derives exact backend conversation URL and scope check", () => {
    expect(buildBackendConversationUrl("conv-1")).toBe(
      "https://chatgpt.com/backend-api/conversation/conv-1",
    );
    expect(isSameConversationUrl("https://chatgpt.com/c/conv-1", "conv-1")).toBe(true);
    expect(isSameConversationUrl("https://chatgpt.com/g/project/c/conv-1", "conv-1")).toBe(true);
    expect(isSameConversationUrl("https://chatgpt.com/g/g-p-123/project/c/conv-1", "conv-1")).toBe(
      true,
    );
    expect(isSameConversationUrl("https://chatgpt.com/c/other", "conv-1")).toBe(false);
    expect(isSameConversationUrl("https://chatgpt.com/g/project/c/other", "conv-1")).toBe(false);
    expect(isSameConversationUrl("https://chatgpt.com/", "conv-1")).toBe(false);
  });

  test("requires and revalidates complete affinity before archive mutations", async () => {
    const expectedDigest = "a".repeat(64);
    const expectedEmail = "owner@example.test";
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: expression.includes("/api/auth/session")
            ? { accountDigest: expectedDigest, email: expectedEmail }
            : "https://chatgpt.com/c/conv-1",
        },
      })),
    };

    await expect(
      assertChatGptExportMutationAffinityForTest(
        runtime as never,
        expectedDigest,
        "conv-1",
        "archive mutation",
        expectedEmail,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertChatGptExportMutationAffinityForTest(runtime as never, expectedDigest, "conv-1"),
    ).rejects.toThrow(/complete ChatGPT account affinity/i);

    runtime.evaluate.mockImplementation(async ({ expression }: { expression: string }) => ({
      result: {
        value: expression.includes("/api/auth/session")
          ? { accountDigest: expectedDigest, email: expectedEmail }
          : "https://chatgpt.com/c/other",
      },
    }));
    await expect(
      assertChatGptExportMutationAffinityForTest(
        runtime as never,
        expectedDigest,
        "conv-1",
        "archive mutation",
        expectedEmail,
      ),
    ).rejects.toThrow(/conversation changed before archive mutation/i);

    runtime.evaluate.mockImplementation(async ({ expression }: { expression: string }) => ({
      result: {
        value: expression.includes("/api/auth/session")
          ? { accountDigest: "b".repeat(64), email: expectedEmail }
          : "https://chatgpt.com/c/conv-1",
      },
    }));
    await expect(
      assertChatGptExportMutationAffinityForTest(
        runtime as never,
        expectedDigest,
        "conv-1",
        "archive mutation",
        expectedEmail,
      ),
    ).rejects.toThrow(/account identity changed before archive mutation/i);
  });

  test("binds read-only exact GETs to the expected bearer JWT identity", () => {
    const expectedDigest = "a".repeat(64);
    const expression = buildReadOnlyConversationGetExpressionForTest(
      "https://chatgpt.com/backend-api/conversation/conv-1",
      expectedDigest,
      "Owner@Example.Test",
    );

    expect(expression).toContain(
      'const TARGET = "https://chatgpt.com/backend-api/conversation/conv-1"',
    );
    expect(expression).toContain('const EXPECTED_CONVERSATION_ID = "conv-1"');
    expect(expression).toContain(`const EXPECTED_ACCOUNT_DIGEST = "${expectedDigest}"`);
    expect(expression).toContain('const EXPECTED_EMAIL = "owner@example.test"');
    expect(expression).toContain('payload?.["https://api.openai.com/auth"]');
    expect(expression).toContain('payload?.["https://api.openai.com/profile"]');
    expect(expression).toContain("crypto.subtle.digest");
    expect(expression).toContain("cookieIdentity.accountDigest !== tokenIdentity.accountDigest");
    expect(expression).toContain('headers.set("authorization", "Bearer " + accessToken)');
    expect(expression).toContain("responseUrl !== TARGET");
    expect(expression).toContain("conversationId !== EXPECTED_CONVERSATION_ID");
    expect(expression).toContain('method: "GET"');
    expect(expression).toContain('redirect: "error"');
    expect(expression).not.toMatch(/\b(?:POST|PUT|PATCH|DELETE)\b/);
    expect(expression).not.toContain("is_archived");
    expect(expression).not.toContain("localStorage");
    expect(expression).not.toContain("sessionStorage");
  });

  test("rejects invalid expected affinity and bounds JWT segments before decoding", () => {
    expect(() =>
      buildReadOnlyConversationGetExpressionForTest(
        "https://chatgpt.com/backend-api/conversation/conv-1",
        "a".repeat(65),
        "owner@example.test",
      ),
    ).toThrow(/account affinity is invalid/i);
    expect(() =>
      buildReadOnlyConversationGetExpressionForTest(
        "https://chatgpt.com/backend-api/conversation/conv-1",
        "a".repeat(64),
        "owner@example",
      ),
    ).toThrow(/account affinity is invalid/i);

    const expression = buildReadOnlyConversationGetExpressionForTest(
      "https://chatgpt.com/backend-api/conversation/conv-1",
      "a".repeat(64),
      "owner@example.test",
    );
    expect(expression).toContain("const MAX_JWT_SEGMENT_LENGTH = 8192");
    expect(expression.indexOf("match.slice(1).some")).toBeLessThan(expression.indexOf("atob("));
  });

  test("rejects a mismatched bearer identity inside the exact GET expression", async () => {
    const userId = "approved-user";
    const expectedDigest = createHash("sha256").update(userId).digest("hex");
    const jwtPayload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_user_id: "other-user" },
        "https://api.openai.com/profile": { email: "owner@example.test" },
      }),
    ).toString("base64url");
    const expression = buildReadOnlyConversationGetExpressionForTest(
      "https://chatgpt.com/backend-api/conversation/conv-1",
      expectedDigest,
      "owner@example.test",
    );
    const sessionTarget = "https://chatgpt.com/api/auth/session";
    const fetch = vi.fn(async (input: string) => {
      if (input !== sessionTarget) throw new Error("backend GET must not run");
      return {
        ok: true,
        redirected: false,
        url: sessionTarget,
        json: async () => ({
          user: { id: userId, email: "owner@example.test" },
          accessToken: `header.${jwtPayload}.signature`,
        }),
      };
    });
    const run = Function("window", "location", "fetch", `return ${expression};`) as (
      window: object,
      location: { href: string },
      fetch: typeof globalThis.fetch,
    ) => Promise<unknown>;

    await expect(run({}, { href: "https://chatgpt.com/" }, fetch as never)).rejects.toThrow(
      /bearer identity does not match/i,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("derives the exact-GET deadline in the page clock from a relative budget", async () => {
    const userId = "approved-user";
    const expectedDigest = createHash("sha256").update(userId).digest("hex");
    const jwtPayload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_user_id: userId },
        "https://api.openai.com/profile": { email: "owner@example.test" },
      }),
    ).toString("base64url");
    const expression = buildReadOnlyConversationGetExpressionForTest(
      "https://chatgpt.com/backend-api/conversation/conv-1",
      expectedDigest,
      "owner@example.test",
      250,
    );
    const digest = Uint8Array.from(Buffer.from(expectedDigest, "hex"));
    const pageCrypto = { subtle: { digest: async () => digest } };
    let signalBackendStarted: () => void;
    const backendStarted = new Promise<void>((resolve) => {
      signalBackendStarted = resolve;
    });
    let scheduledMs: number | undefined;
    let timeoutCallback: (() => void) | undefined;
    const sessionTarget = "https://chatgpt.com/api/auth/session";
    const pageFetch = vi.fn((input: string, init?: { signal?: AbortSignal }) => {
      if (input === sessionTarget) {
        return Promise.resolve({
          ok: true,
          redirected: false,
          url: sessionTarget,
          json: async () => ({
            user: { id: userId, email: "owner@example.test" },
            accessToken: `header.${jwtPayload}.signature`,
          }),
        });
      }
      if (input !== "https://chatgpt.com/backend-api/conversation/conv-1") {
        throw new Error(`Unexpected fetch URL: ${input}`);
      }
      signalBackendStarted();
      return new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const run = Function(
      "window",
      "location",
      "fetch",
      "Date",
      "setTimeout",
      "clearTimeout",
      "crypto",
      "globalThis",
      `return ${expression};`,
    ) as (
      window: object,
      location: { href: string },
      fetch: (input: string, init?: { signal?: AbortSignal }) => Promise<unknown>,
      Date: { now: () => number },
      setTimeout: (callback: () => void, ms: number) => number,
      clearTimeout: (timeout: number) => void,
      crypto: typeof pageCrypto,
      pageGlobal: { crypto: typeof pageCrypto },
    ) => Promise<unknown>;

    const result = run(
      {},
      { href: "https://chatgpt.com/" },
      pageFetch,
      { now: () => 10_000_000 },
      (callback, ms) => {
        timeoutCallback = callback;
        scheduledMs = ms;
        return 1;
      },
      () => undefined,
      pageCrypto,
      { crypto: pageCrypto },
    );
    const reachedBackend = await Promise.race([
      backendStarted.then(() => true),
      result.then(
        () => false,
        () => false,
      ),
    ]);

    expect(reachedBackend).toBe(true);
    expect(expression).toContain("const REMAINING_MS = 250");
    expect(expression).toContain("const DEADLINE = Date.now() + REMAINING_MS");
    expect(scheduledMs).toBe(250);
    timeoutCallback?.();
    await expect(result).rejects.toThrow(/exact GET timed out/i);
  });

  test("capture hooks expose deterministic raw-body cleanup", () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const hook = buildScopedBackendCaptureHook(targetApiUrl);
    const cleanup = buildChatGptCaptureCleanupExpressionForTest(targetApiUrl);
    expect(hook).toContain(`const TARGET = "${targetApiUrl}"`);
    expect(hook).toContain("window !== window.top");
    expect(hook).toContain("url !== TARGET");
    expect(hook).toContain("active = false");
    expect(hook).toContain("window.fetch = originalFetch");
    expect(hook).toContain("window.XMLHttpRequest = OriginalXHR");
    expect(hook).toContain("wrappedFetch.__oracleChatGptBackendCaptureTarget = TARGET");
    expect(hook).toContain("WrappedXHR.__oracleChatGptBackendCaptureTarget = TARGET");
    expect(hook).toContain(
      'sessionStorage.setItem("__oracleChatGptBackendCapture:" + TARGET, text)',
    );
    expect(cleanup).toContain("sessionStorage.removeItem(CAPTURE_KEY)");
    expect(cleanup).toContain("sessionStorage.getItem(CAPTURE_KEY) === null");
    expect(cleanup).toContain('const WRAPPER_MARKER = "__oracleChatGptBackendCaptureTarget"');
    expect(cleanup).toContain("globalCleared && storageCleared && fetchRestored && xhrRestored");
    expect(cleanup).toContain("delete hit.text");
    expect(cleanup).toContain("delete window.__oracleChatGptBackendCapture");
    expect(hook).not.toContain("localStorage");
    expect(hook).not.toContain("cookie");
  });

  test("capture cleanup verification fails when a raw wrapper remains installed", () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const cleanup = buildChatGptCaptureCleanupExpressionForTest(targetApiUrl);
    const lingeringFetch = Object.assign(() => undefined, {
      __oracleChatGptBackendCaptureTarget: targetApiUrl,
    });
    const windowStub = {
      fetch: lingeringFetch,
      XMLHttpRequest: function XMLHttpRequest() {},
      __oracleChatGptBackendCapture: {
        hits: [],
        cleanup: () => undefined,
      },
    };
    const sessionStorageStub = {
      removeItem: () => undefined,
      getItem: () => null,
    };
    const run = Function("window", "sessionStorage", `return ${cleanup};`) as (
      window: typeof windowStub,
      sessionStorage: typeof sessionStorageStub,
    ) => boolean;

    expect(run(windowStub, sessionStorageStub)).toBe(false);
  });

  test("capture timeout diagnostics expose only non-locating metadata", () => {
    const secret = "raw-secret-body";
    const privateUrl = "https://chatgpt.com/backend-api/conversation/private-conversation";
    const privateTitle = "Private conversation title";
    const message = formatChatGptCaptureTimeoutForTest({
      href: "https://chatgpt.com/c/private-conversation",
      title: privateTitle,
      hit: {
        kind: "fetch",
        url: privateUrl,
        status: 503,
        ok: false,
        contentType: "application/json",
        chars: 321,
        title: privateTitle,
        conversation_id: "private-conversation",
        current_node: "private-current-node",
        mappingCount: 7,
      },
      hits: [
        {
          kind: "fetch",
          url: privateUrl,
          status: 503,
          contentType: "application/json",
          chars: 321,
          title: privateTitle,
          conversation_id: "private-conversation",
          current_node: "private-current-node",
          text: secret,
          bodyPreview: secret,
          error: secret,
          mappingCount: 7,
        },
      ],
    });
    expect(message).toContain('"kind":"fetch"');
    expect(message).toContain('"status":503');
    expect(message).toContain('"contentType":"application/json"');
    expect(message).toContain('"chars":321');
    expect(message).toContain('"mappingCount":7');
    expect(message).toContain('"hitCount":1');
    for (const privateValue of [
      privateUrl,
      privateTitle,
      "private-conversation",
      "private-current-node",
      secret,
    ]) {
      expect(message).not.toContain(privateValue);
    }
    expect(message).not.toMatch(/"(?:href|title|url|conversation_id|current_node)"/);
    expect(message).not.toContain("bodyPreview");
    expect(message).not.toContain('"text"');
  });

  test("retrieves persisted capture text after a transient miss", async () => {
    const payload = '{"ok":true}';
    let attempts = 0;
    const result = await retrieveCapturedTextWithEvaluator(
      async (expression) => {
        expect(expression).toContain(
          'sessionStorage.getItem("__oracleChatGptBackendCapture:" + target)',
        );
        expect(expression).not.toContain(
          'sessionStorage.removeItem("__oracleChatGptBackendCapture:" + target)',
        );
        expect(expression).not.toContain("delete window.__oracleChatGptBackendCapture");
        attempts += 1;
        return (attempts === 1 ? null : payload) as never;
      },
      "https://chatgpt.com/backend-api/conversation/conv-1",
      payload.length,
      payload.length,
    );
    expect(result).toBe(payload);
    expect(attempts).toBe(2);
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects invalid core chunk size %s before evaluating page state",
    async (chunkSize) => {
      const evaluate = vi.fn();
      await expect(
        retrieveCapturedTextWithEvaluator(
          evaluate as never,
          "https://chatgpt.com/backend-api/conversation/conv-1",
          10,
          chunkSize,
        ),
      ).rejects.toThrow(/finite positive integer/i);
      expect(evaluate).not.toHaveBeenCalled();
    },
  );

  test("normalizes backend content types without losing structured values", () => {
    expect(contentToText({ content_type: "text", parts: ["hello", { ok: true }] })).toContain(
      "hello",
    );
    expect(contentToText({ content_type: "code", text: "print(1)" })).toBe("print(1)");
    expect(contentToText({ content_type: "execution_output", text: "done" })).toBe("done");
    expect(contentToText({ content_type: "reasoning_recap", content: "summary" })).toBe("summary");
    expect(
      contentToText({ content_type: "thoughts", thoughts: [{ text: "visible thought" }] }),
    ).toContain("visible thought");
  });

  test("scans exported text for secret-like markers without treating marker mentions as findings", () => {
    expect(scanTextForSecretLikeMarkers("conversation.md", "OPENAI_API_KEY")).toMatchObject({
      findings: [],
      warnings: [
        "marker mention present in conversation.md: OPENAI_API_KEY",
        "marker mention present in conversation.md: API_KEY",
      ],
    });
    expect(scanTextForSecretLikeMarkers("conversation.md", "TOKEN=abc123").findings).toEqual([
      { path: "conversation.md", marker: "TOKEN assignment" },
    ]);
  });

  test("writes bundles only into fresh private directories without symlink parents", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "oracle-export-permissions-"),
    );
    const payload = {
      target_url: "https://chatgpt.com/c/conv-1",
      final_url: "https://chatgpt.com/c/conv-1",
      conversation_id: "conv-1",
      expected_conversation_id: "conv-1",
      scope_ok: true,
      extraction_method: "test",
      turns: [],
      stats: { turn_count: 0 },
    };
    const writeBundle = (outDir: string) =>
      writeChatGptExportBundleForTest({
        outDir,
        rawText: '{"conversation_id":"conv-1","mapping":{}}',
        payload,
        captureInfo: {},
      });

    try {
      const outDir = path.join(root, "bundle");
      if (process.platform === "win32") {
        await expect(writeBundle(outDir)).rejects.toThrow(/disabled on Windows.*ACL/i);
        await expect(fs.stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      await writeBundle(outDir);
      expect((await fs.stat(outDir)).mode & 0o777).toBe(0o700);
      for (const file of await fs.readdir(outDir)) {
        expect((await fs.stat(path.join(outDir, file))).mode & 0o777).toBe(0o600);
      }
      await expect(writeBundle(outDir)).rejects.toThrow(/fresh path.*already exist/i);

      const preexisting = path.join(root, "preexisting");
      await fs.mkdir(preexisting, { mode: 0o700 });
      await fs.chmod(preexisting, 0o700);
      await expect(writeBundle(preexisting)).rejects.toThrow(/fresh path.*already exist/i);

      const realParent = path.join(root, "real-parent");
      const symlinkParent = path.join(root, "symlink-parent");
      await fs.mkdir(realParent, { mode: 0o700 });
      await fs.symlink(realParent, symlinkParent, "dir");
      await expect(writeBundle(path.join(symlinkParent, "bundle"))).rejects.toThrow(
        /parent components.*symlink/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  testNonWindows("removes a partial sensitive bundle when a precommit write fails", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "oracle-export-rollback-"),
    );
    const outDir = path.join(root, "bundle");
    try {
      await expect(
        writeChatGptExportBundleForTest({
          outDir,
          rawText: '{"conversation_id":"conv-1","mapping":{}}',
          payload: {
            target_url: "https://chatgpt.com/c/conv-1",
            stats: { turn_count: 0 },
            unserializable: BigInt(1),
          },
          captureInfo: {},
        }),
      ).rejects.toThrow(/BigInt/i);
      await expect(fs.stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed before creating exports when Windows ACL guarantees are unavailable", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const outDir = path.join(os.tmpdir(), `oracle-export-windows-${Date.now()}`);
    try {
      await expect(
        captureApprovedChatGptConversationBackend({
          targetUrl: "https://chatgpt.com/c/conv-1",
          outDir,
        }),
      ).rejects.toThrow(/disabled on Windows.*ACL/i);
      await expect(fs.stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  test("converts current-node path to normalized payload stats", () => {
    const payload = backendToPayload(
      {
        title: "Thread",
        conversation_id: "conv-1",
        current_node: "assistant-1",
        mapping: {
          root: {
            id: "root",
            parent: null,
            children: ["user-1"],
            message: null,
          },
          "user-1": {
            id: "user-1",
            parent: "root",
            children: ["assistant-1"],
            message: {
              id: "msg-user",
              author: { role: "user" },
              content: { content_type: "text", parts: ["Question"] },
              metadata: {},
            },
          },
          "assistant-1": {
            id: "assistant-1",
            parent: "user-1",
            children: [],
            message: {
              id: "msg-assistant",
              author: { role: "assistant" },
              content: { content_type: "text", parts: ["Answer"] },
              metadata: {
                attachments: [{ name: "notes.txt", download_url: "https://example.test" }],
              },
            },
          },
        },
      },
      "https://chatgpt.com/c/conv-1",
      "sha",
      123,
    );

    expect(payload.scope_ok).toBe(true);
    expect(payload.stats).toMatchObject({
      turn_count: 2,
      user_turns: 1,
      assistant_turns: 1,
      mapping_node_count: 3,
      current_path_node_count: 3,
      asset_candidates: 1,
    });
    expect(payload.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "Question" }),
        expect.objectContaining({ role: "assistant", text: "Answer" }),
      ]),
    );
  });
});
