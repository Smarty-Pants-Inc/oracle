import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import {
  assertChatGptExportMutationAffinityForTest,
  backendToPayload,
  archivedSettingsUrlFromConversationUrl,
  buildBackendConversationUrl,
  buildArchivedConversationRecoveryHookForTest,
  buildApprovedBackendFetchExpression,
  captureApprovedChatGptConversationBackend,
  buildScopedBackendCaptureHook,
  cleanupArchivedConversationRecoveryForTest,
  cleanupScopedBackendCaptureForTest,
  finalizeCompletedOpenBrowserUseExport,
  contentToText,
  conversationIdFromChatGptUrl,
  isSameConversationUrl,
  pollCaptureWithPassiveFallbackForTest,
  requestApprovedBackendCapture,
  remainingCaptureBudgetForTest,
  runBeforeCaptureDeadlineForTest,
  retrieveCapturedTextWithEvaluator,
  scanTextForSecretLikeMarkers,
  writeChatGptExportBundleForTest,
  type CapturePollResult,
} from "../../src/browser/chatgptExport.js";

describe("ChatGPT conversation export helpers", () => {
  const captureOwner = "capture-test-owner";
  const archiveOwner = "archive-test-owner";
  test("accepts only exact chatgpt.com conversation URLs", () => {
    expect(conversationIdFromChatGptUrl("https://chatgpt.com/c/abc-123")).toBe("abc-123");
    expect(conversationIdFromChatGptUrl("https://chatgpt.com/c/abc-123/")).toBe("abc-123");
    expect(conversationIdFromChatGptUrl("https://chatgpt.com/g/project-1/c/abc-123")).toBe(
      "abc-123",
    );
    expect(conversationIdFromChatGptUrl("https://chatgpt.com/g/g-p-123/c/abc-123/")).toBe(
      "abc-123",
    );
    expect(() => conversationIdFromChatGptUrl("https://chat.openai.com/c/abc")).toThrow(
      /chatgpt\.com\/c/,
    );
    expect(() => conversationIdFromChatGptUrl("https://chatgpt.com/")).toThrow(/specific/i);
    expect(() => conversationIdFromChatGptUrl("https://chatgpt.com/g/example/project")).toThrow(
      /specific/i,
    );
    expect(() => conversationIdFromChatGptUrl("https://chatgpt.com:444/c/abc")).toThrow(
      /chatgpt\.com\/c/,
    );
    expect(() => conversationIdFromChatGptUrl("https://chatgpt.com/%63/abc")).toThrow(
      /chatgpt\.com\/c/,
    );
    expect(() =>
      conversationIdFromChatGptUrl(
        "https://chatgpt.com/c/WEB:32229414-5afa-4478-890c-9ca80aa82430",
      ),
    ).toThrow(/specific/i);
  });

  test("rejects a browser swap before exact export attachment", async () => {
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

  test("keeps a completed OBU export when task-tab cleanup fails", async () => {
    const finalize = vi.fn().mockRejectedValue(
      new BrowserAutomationError("Failed to finalize the task-owned main-Chrome Oracle tab.", {
        stage: "open-browser-use",
        code: "tab-finalize-failed",
        recoveryHandle: { transport: "obu", sessionId: "export-session", tabId: 9 },
      }),
    );

    await expect(finalizeCompletedOpenBrowserUseExport({ finalize })).resolves.toEqual([
      {
        code: "obu-tab-finalize-failed",
        severity: "warning",
        message: expect.stringContaining("Export completed"),
        details: {
          stage: "open-browser-use",
          code: "tab-finalize-failed",
          recoveryHandle: { transport: "obu", sessionId: "export-session", tabId: 9 },
        },
      },
    ]);
    expect(finalize).toHaveBeenCalledWith(false);
  });

  test("redacts URLs from persisted OBU finalization warnings", async () => {
    const finalize = vi.fn().mockRejectedValue(
      new BrowserAutomationError("Could not finalize https://chatgpt.com/c/private-conversation", {
        actualUrl: "https://chatgpt.com/c/private-conversation",
        endpoint: "https://chatgpt.com/backend-api/conversation/private-conversation",
      }),
    );

    const warnings = await finalizeCompletedOpenBrowserUseExport({ finalize });

    expect(JSON.stringify(warnings)).not.toContain("private-conversation");
    expect(warnings).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("[redacted-url]"),
        details: { endpoint: "[redacted-url]" },
      }),
    ]);
  });

  test.skipIf(process.platform === "win32")(
    "writes export bundles with private modes, including overwritten files",
    async () => {
      const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-export-private-mode-"));
      const outDir = path.join(parentDir, "bundle");
      const files = [
        "backend-conversation.json",
        "backend-capture-info.json",
        "conversation.json",
        "payload.json",
        "conversation.md",
        "manifest.json",
        "redaction-report.json",
        "SHA256SUMS.txt",
      ];
      const rawText = JSON.stringify({ conversation_id: "conv-1", title: "private export" });
      try {
        await fs.mkdir(outDir, { mode: 0o755 });
        await fs.chmod(outDir, 0o755);
        await Promise.all(
          files.map(async (file) => {
            const output = path.join(outDir, file);
            await fs.writeFile(output, "permissive stale content", { mode: 0o644 });
            await fs.chmod(output, 0o644);
          }),
        );

        await writeChatGptExportBundleForTest({
          outDir,
          rawText,
          payload: {
            target_url: "https://chatgpt.com/c/conv-1",
            final_url: "https://chatgpt.com/c/conv-1",
            conversation_id: "conv-1",
            expected_conversation_id: "conv-1",
            scope_ok: true,
            title: "private export",
            extraction_method: "test",
            exported_at: "2026-08-23T00:00:00.000Z",
            backend_probe: {},
            stats: {
              turn_count: 0,
              user_turns: 0,
              assistant_turns: 0,
              tool_turns: 0,
              system_turns: 0,
            },
            turns: [],
          },
          captureInfo: { captured_at: "2026-08-23T00:00:00.000Z" },
        });

        expect((await fs.stat(outDir)).mode & 0o777).toBe(0o700);
        await Promise.all(
          files.map(async (file) => {
            expect((await fs.stat(path.join(outDir, file))).mode & 0o777).toBe(0o600);
          }),
        );
        expect(await fs.readFile(path.join(outDir, "backend-conversation.json"), "utf8")).toBe(
          rawText,
        );
      } finally {
        await fs.rm(parentDir, { recursive: true, force: true });
      }
    },
  );
  test.skipIf(process.platform === "win32")("refuses symlinked export output files", async () => {
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-export-symlink-"));
    const outDir = path.join(parentDir, "bundle");
    const outside = path.join(parentDir, "outside.json");
    try {
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(outside, "must remain unchanged", "utf8");
      await fs.symlink(outside, path.join(outDir, "backend-conversation.json"));
      await expect(
        writeChatGptExportBundleForTest({
          outDir,
          rawText: "{}",
          payload: { target_url: "https://chatgpt.com/c/conv-1", stats: {} },
          captureInfo: {},
        }),
      ).rejects.toBeDefined();
      await expect(fs.readFile(outside, "utf8")).resolves.toBe("must remain unchanged");
    } finally {
      await fs.rm(parentDir, { recursive: true, force: true });
    }
  });

  test("derives exact backend conversation URL and project-aware scope check", () => {
    const rootUrl = "https://chatgpt.com/c/conv-1";
    const projectUrl = "https://chatgpt.com/g/project/c/conv-1";
    expect(buildBackendConversationUrl("conv-1")).toBe(
      "https://chatgpt.com/backend-api/conversation/conv-1",
    );
    expect(isSameConversationUrl(rootUrl, rootUrl)).toBe(true);
    expect(isSameConversationUrl(`${rootUrl}/?view=full`, rootUrl)).toBe(true);
    expect(isSameConversationUrl(projectUrl, projectUrl)).toBe(true);
    expect(isSameConversationUrl(rootUrl, projectUrl)).toBe(false);
    expect(isSameConversationUrl(projectUrl, rootUrl)).toBe(false);
    expect(isSameConversationUrl("https://chatgpt.com/g/other/c/conv-1", projectUrl)).toBe(false);
    expect(isSameConversationUrl(`${rootUrl}/extra`, rootUrl)).toBe(false);
    expect(isSameConversationUrl("https://chatgpt.com/c/other", rootUrl)).toBe(false);
    expect(isSameConversationUrl("https://chatgpt.com/", rootUrl)).toBe(false);
  });

  test("revalidates account and exact project route before archive mutations", async () => {
    const expectedDigest = "a".repeat(64);
    const expectedUrl = "https://chatgpt.com/g/project-a/c/conv-1";
    let actualUrl = expectedUrl;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("/api/auth/session")) {
          return { result: { value: expectedDigest } };
        }
        const check = new Function("location", "URL", `return (${expression});`) as (
          location: { href: string },
          URL: typeof globalThis.URL,
        ) => boolean;
        return { result: { value: check({ href: actualUrl }, URL) } };
      }),
    };

    await expect(
      assertChatGptExportMutationAffinityForTest(runtime as never, expectedDigest, expectedUrl),
    ).resolves.toBeUndefined();

    actualUrl = "https://chatgpt.com/g/private-project/c/private-conversation";
    const error = await assertChatGptExportMutationAffinityForTest(
      runtime as never,
      expectedDigest,
      expectedUrl,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/conversation changed before archive mutation/i);
    expect((error as Error).message).not.toContain(actualUrl);
    expect(runtime.evaluate.mock.calls.at(-1)?.[0].expression).not.toBe("location.href");
  });

  test("derives archived-chat settings without leaving the approved project", () => {
    expect(
      archivedSettingsUrlFromConversationUrl("https://chatgpt.com/g/g-p-123-oracle/c/conv-1"),
    ).toBe("https://chatgpt.com/g/g-p-123-oracle/project#settings/DataControls/ArchivedChats");
    expect(archivedSettingsUrlFromConversationUrl("https://chatgpt.com/c/conv-1")).toBe(
      "https://chatgpt.com/#settings/DataControls/ArchivedChats",
    );
  });

  test("recovers only the exact archived conversation through ChatGPT's authenticated request", () => {
    const hook = buildArchivedConversationRecoveryHookForTest("conv-1");
    expect(hook).toContain('const TARGET = "https://chatgpt.com/backend-api/conversation/conv-1"');
    expect(hook).toContain('url.pathname === "/backend-api/conversations"');
    expect(hook).toContain('url.searchParams.get("is_archived") === "true"');
    expect(hook).toContain('method: "PATCH"');
    expect(hook).toContain("JSON.stringify({ is_archived: false })");
    expect(hook).toContain("new Headers(request.headers)");
    expect(hook).not.toContain("localStorage");
    expect(hook).not.toContain("document.cookie");
    expect(hook).toContain('url.origin === "https://chatgpt.com"');
    expect(hook).toContain("EXPECTED_ACCOUNT_DIGEST");
    expect(hook).toContain("EXPECTED_WORKSPACE_DIGEST");
    expect(hook).toContain("requestWorkspaceDigest");
    expect(hook).toContain("identityMatches");
    expect(hook).toContain("routeMatches() &&");
    expect(hook).toContain('const SETTINGS_HASH = "#settings/DataControls/ArchivedChats"');
    expect(hook).toContain('current.search !== ""');
    expect(hook).toContain("current.hash !== SETTINGS_HASH");
    expect(hook.lastIndexOf("if (!routeMatches())")).toBeLessThan(hook.indexOf("const patch"));
  });

  test("refuses archived-list authorization captured before the expected account is active", async () => {
    const expectedUserId = "account-a";
    const staleUserId = "account-b";
    const workspaceId = "workspace-a";
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    let activeUserId = staleUserId;
    const pageFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/auth/session") {
        const userId = activeUserId;
        activeUserId = expectedUserId;
        return new Response(
          JSON.stringify({ user: { id: userId }, account: { id: workspaceId } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/backend-api/conversations")) {
        return new Response("{}", { status: 200 });
      }
      if (url === targetApiUrl && init?.method === "PATCH") {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const page = {
      fetch: pageFetch as unknown as typeof fetch,
      document: {
        getElementById: () => ({ textContent: "{}" }),
      },
    } as {
      fetch: typeof fetch;
      document: { getElementById: () => { textContent: string } };
      __oracleArchivedConversationRecovery?: Record<string, unknown>;
    };
    const runtimeGlobal = { crypto: globalThis.crypto };
    const storage = { getItem: vi.fn(() => null) };
    const install = new Function(
      "window",
      "document",
      "location",
      "Request",
      "Headers",
      "URL",
      "crypto",
      "TextEncoder",
      "globalThis",
      "sessionStorage",
      buildArchivedConversationRecoveryHookForTest("conv-1", {
        targetUrl: "https://chatgpt.com/c/conv-1",
        accountDigest: digest(expectedUserId),
        workspaceDigest: digest(workspaceId),
      }),
    ) as (...args: unknown[]) => void;
    install(
      page,
      page.document,
      { href: "https://chatgpt.com/#settings/DataControls/ArchivedChats" },
      Request,
      Headers,
      URL,
      globalThis.crypto,
      TextEncoder,
      runtimeGlobal,
      storage,
    );
    const archivedList = new Request(
      "https://chatgpt.com/backend-api/conversations?is_archived=true",
      {
        headers: {
          Authorization: "Bearer stale-account-token",
          "ChatGPT-Account-Id": workspaceId,
        },
      },
    );
    await page.fetch(archivedList);

    expect(page.__oracleArchivedConversationRecovery).toMatchObject({
      status: "failed",
      code: "affinity-mismatch",
      recovered: false,
    });
    expect(pageFetch).not.toHaveBeenCalledWith(
      targetApiUrl,
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  test("does not recover when the triggering archived-list request fails", async () => {
    const expectedUserId = "account-a";
    const workspaceId = "workspace-a";
    const freshToken = "fresh-account-a-token";
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const patch = vi.fn();
    const pageFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/auth/session") {
        return new Response(
          JSON.stringify({ user: { id: expectedUserId }, account: { id: workspaceId } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/backend-api/conversations")) return new Response("{}", { status: 503 });
      if (url === targetApiUrl && init?.method === "PATCH") {
        patch();
        return new Response("{}", { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const page = {
      fetch: pageFetch as unknown as typeof fetch,
      document: {
        getElementById: () => ({
          textContent: JSON.stringify({
            session: {
              user: { id: expectedUserId },
              account: { id: workspaceId },
              accessToken: freshToken,
            },
          }),
        }),
      },
    } as {
      fetch: typeof fetch;
      document: { getElementById: () => { textContent: string } };
      __oracleArchivedConversationRecovery?: Record<string, unknown>;
    };
    const install = new Function(
      "window",
      "document",
      "location",
      "Request",
      "Headers",
      "URL",
      "crypto",
      "TextEncoder",
      "globalThis",
      "sessionStorage",
      buildArchivedConversationRecoveryHookForTest("conv-1", {
        targetUrl: "https://chatgpt.com/c/conv-1",
        accountDigest: digest(expectedUserId),
        workspaceDigest: digest(workspaceId),
      }),
    ) as (...args: unknown[]) => void;
    install(
      page,
      page.document,
      { href: "https://chatgpt.com/#settings/DataControls/ArchivedChats" },
      Request,
      Headers,
      URL,
      globalThis.crypto,
      TextEncoder,
      { crypto: globalThis.crypto },
      { getItem: vi.fn(() => null) },
    );

    await page.fetch(
      new Request("https://chatgpt.com/backend-api/conversations?is_archived=true", {
        headers: { "ChatGPT-Account-Id": workspaceId },
      }),
    );

    expect(patch).not.toHaveBeenCalled();
    expect(page.__oracleArchivedConversationRecovery).toMatchObject({
      status: "failed",
      code: "archived-list-failed",
      listStatus: 503,
      recovered: false,
    });
  });

  test("issues at most one recovery PATCH for overlapping archived-list requests", async () => {
    const expectedUserId = "account-a";
    const workspaceId = "workspace-a";
    const freshToken = "fresh-account-a-token";
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    let resolvePatch: (response: Response) => void = () => {};
    const patch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvePatch = resolve;
        }),
    );
    const pageFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/auth/session") {
        return new Response(
          JSON.stringify({ user: { id: expectedUserId }, account: { id: workspaceId } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/backend-api/conversations")) return new Response("{}", { status: 200 });
      if (url === targetApiUrl && init?.method === "PATCH") return patch();
      throw new Error(`Unexpected request: ${url}`);
    });
    const page = {
      fetch: pageFetch as unknown as typeof fetch,
      document: {
        getElementById: () => ({
          textContent: JSON.stringify({
            session: {
              user: { id: expectedUserId },
              account: { id: workspaceId },
              accessToken: freshToken,
            },
          }),
        }),
      },
    } as {
      fetch: typeof fetch;
      document: { getElementById: () => { textContent: string } };
      __oracleArchivedConversationRecovery?: Record<string, unknown>;
    };
    const install = new Function(
      "window",
      "document",
      "location",
      "Request",
      "Headers",
      "URL",
      "crypto",
      "TextEncoder",
      "globalThis",
      "sessionStorage",
      buildArchivedConversationRecoveryHookForTest("conv-1", {
        targetUrl: "https://chatgpt.com/c/conv-1",
        accountDigest: digest(expectedUserId),
        workspaceDigest: digest(workspaceId),
      }),
    ) as (...args: unknown[]) => void;
    install(
      page,
      page.document,
      { href: "https://chatgpt.com/#settings/DataControls/ArchivedChats" },
      Request,
      Headers,
      URL,
      globalThis.crypto,
      TextEncoder,
      { crypto: globalThis.crypto },
      { getItem: vi.fn(() => null) },
    );
    const request = () =>
      page.fetch(
        new Request("https://chatgpt.com/backend-api/conversations?is_archived=true", {
          headers: { "ChatGPT-Account-Id": workspaceId },
        }),
      );

    const first = request();
    await vi.waitFor(() => expect(patch).toHaveBeenCalledOnce());
    const second = request();
    await second;
    expect(patch).toHaveBeenCalledOnce();
    resolvePatch(new Response("{}", { status: 200 }));
    await first;
    expect(page.__oracleArchivedConversationRecovery).toMatchObject({
      status: "recovered",
      recovered: true,
    });
  });

  test("replaces stale archived-list authorization with the validated current token", async () => {
    const expectedUserId = "account-a";
    const workspaceId = "workspace-a";
    const freshToken = "fresh-account-a-token";
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const patchHeaders: string[] = [];
    const pageFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/auth/session") {
        return new Response(
          JSON.stringify({ user: { id: expectedUserId }, account: { id: workspaceId } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/backend-api/conversations")) return new Response("{}", { status: 200 });
      if (url === targetApiUrl && init?.method === "PATCH") {
        patchHeaders.push(new Headers(init.headers).get("authorization") || "");
        patchHeaders.push(new Headers(init.headers).get("chatgpt-account-id") || "");
        return new Response("{}", { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const page = {
      fetch: pageFetch as unknown as typeof fetch,
      document: {
        getElementById: () => ({
          textContent: JSON.stringify({
            session: {
              user: { id: expectedUserId },
              account: { id: workspaceId },
              accessToken: freshToken,
            },
          }),
        }),
      },
    } as {
      fetch: typeof fetch;
      document: { getElementById: () => { textContent: string } };
      __oracleArchivedConversationRecovery?: Record<string, unknown>;
    };
    const storage = { getItem: vi.fn(() => null) };
    const install = new Function(
      "window",
      "document",
      "location",
      "Request",
      "Headers",
      "URL",
      "crypto",
      "TextEncoder",
      "globalThis",
      "sessionStorage",
      buildArchivedConversationRecoveryHookForTest("conv-1", {
        targetUrl: "https://chatgpt.com/c/conv-1",
        accountDigest: digest(expectedUserId),
        workspaceDigest: digest(workspaceId),
      }),
    ) as (...args: unknown[]) => void;
    install(
      page,
      page.document,
      { href: "https://chatgpt.com/#settings/DataControls/ArchivedChats" },
      Request,
      Headers,
      URL,
      globalThis.crypto,
      TextEncoder,
      { crypto: globalThis.crypto },
      storage,
    );
    await page.fetch(
      new Request("https://chatgpt.com/backend-api/conversations?is_archived=true", {
        headers: {
          Authorization: "Bearer stale-account-b-token",
          "ChatGPT-Account-Id": workspaceId,
        },
      }),
    );

    expect(page.__oracleArchivedConversationRecovery).toMatchObject({
      status: "recovered",
      recovered: true,
    });
    expect(patchHeaders).toEqual([`Bearer ${freshToken}`, workspaceId]);
  });
  test("refuses archive recovery when a deferred archived list returns after settings drift", async () => {
    const expectedUserId = "account-a";
    const workspaceId = "workspace-a";
    const freshToken = "fresh-account-a-token";
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const archivedListUrl = "https://chatgpt.com/backend-api/conversations?is_archived=true";
    const settingsUrl = "https://chatgpt.com/#settings/DataControls/ArchivedChats";
    const storage = { getItem: vi.fn(() => null) };
    const install = new Function(
      "window",
      "document",
      "location",
      "Request",
      "Headers",
      "URL",
      "crypto",
      "TextEncoder",
      "globalThis",
      "sessionStorage",
      buildArchivedConversationRecoveryHookForTest("conv-1", {
        targetUrl: "https://chatgpt.com/c/conv-1",
        accountDigest: digest(expectedUserId),
        workspaceDigest: digest(workspaceId),
      }),
    ) as (...args: unknown[]) => void;

    for (const driftUrl of [
      "https://chatgpt.com/?drift=1#settings/DataControls/ArchivedChats",
      "https://chatgpt.com/#settings/DataControls/Other",
    ]) {
      let listRequested = false;
      let resolveList: (response: Response) => void = () => {};
      const patch = vi.fn();
      const pageFetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === "/api/auth/session") {
          return Promise.resolve(
            new Response(
              JSON.stringify({ user: { id: expectedUserId }, account: { id: workspaceId } }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        if (url === archivedListUrl) {
          listRequested = true;
          return new Promise<Response>((resolve) => {
            resolveList = resolve;
          });
        }
        if (url === targetApiUrl && init?.method === "PATCH") {
          patch();
          return Promise.resolve(new Response("{}", { status: 200 }));
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      const page = {
        fetch: pageFetch as unknown as typeof fetch,
        document: {
          getElementById: () => ({
            textContent: JSON.stringify({
              session: {
                user: { id: expectedUserId },
                account: { id: workspaceId },
                accessToken: freshToken,
              },
            }),
          }),
        },
      } as {
        fetch: typeof fetch;
        document: { getElementById: () => { textContent: string } };
        __oracleArchivedConversationRecovery?: Record<string, unknown>;
      };
      const location = { href: settingsUrl };
      install(
        page,
        page.document,
        location,
        Request,
        Headers,
        URL,
        globalThis.crypto,
        TextEncoder,
        { crypto: globalThis.crypto },
        storage,
      );

      const list = page.fetch(
        new Request(archivedListUrl, {
          headers: {
            Authorization: "Bearer stale-account-token",
            "ChatGPT-Account-Id": workspaceId,
          },
        }),
      );
      await vi.waitFor(() => {
        expect(listRequested).toBe(true);
      });
      location.href = driftUrl;
      resolveList(new Response("{}", { status: 200 }));
      await list;

      expect(patch).not.toHaveBeenCalled();
      expect(page.__oracleArchivedConversationRecovery).toMatchObject({
        status: "failed",
        recovered: false,
      });
    }
  });
  test("records an ambiguous recovery PATCH and supports exact-target re-archive compensation", async () => {
    const expectedUserId = "account-a";
    const workspaceId = "workspace-a";
    const freshToken = "fresh-account-a-token";
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    let patchAttempt = 0;
    const patchCalls: RequestInit[] = [];
    const pageFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/auth/session") {
        return new Response(
          JSON.stringify({ user: { id: expectedUserId }, account: { id: workspaceId } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/backend-api/conversations")) return new Response("{}", { status: 200 });
      if (url === targetApiUrl && init?.method === "PATCH") {
        patchCalls.push(init);
        patchAttempt += 1;
        return patchAttempt === 1
          ? new Response("server uncertain", { status: 503 })
          : new Response("{}", { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const page = {
      fetch: pageFetch as unknown as typeof fetch,
      document: {
        getElementById: () => ({
          textContent: JSON.stringify({
            session: {
              user: { id: expectedUserId },
              account: { id: workspaceId },
              accessToken: freshToken,
            },
          }),
        }),
      },
    } as {
      fetch: typeof fetch;
      document: { getElementById: () => { textContent: string } };
      __oracleArchivedConversationRecovery?: Record<string, unknown>;
    };
    const location = { href: "https://chatgpt.com/#settings/DataControls/ArchivedChats" };
    const storage = { getItem: vi.fn(() => null) };
    const install = new Function(
      "window",
      "document",
      "location",
      "Request",
      "Headers",
      "URL",
      "crypto",
      "TextEncoder",
      "globalThis",
      "sessionStorage",
      buildArchivedConversationRecoveryHookForTest("conv-1", {
        accountDigest: digest(expectedUserId),
        workspaceDigest: digest(workspaceId),
      }),
    ) as (...args: unknown[]) => void;
    install(
      page,
      page.document,
      location,
      Request,
      Headers,
      URL,
      globalThis.crypto,
      TextEncoder,
      { crypto: globalThis.crypto },
      storage,
    );

    await page.fetch(
      new Request("https://chatgpt.com/backend-api/conversations?is_archived=true", {
        headers: { "ChatGPT-Account-Id": workspaceId },
      }),
    );
    expect(page.__oracleArchivedConversationRecovery).toMatchObject({
      status: "failed",
      patchOutcome: "unknown",
      patchStatus: 503,
    });
    const restore = page.__oracleArchivedConversationRecovery?.restoreArchivedConversation as
      | (() => Promise<{ ok: boolean; status?: number }>)
      | undefined;
    await expect(restore?.()).resolves.toMatchObject({ ok: true, status: 200 });
    expect(patchCalls).toHaveLength(2);
    expect(JSON.parse(String(patchCalls[0]?.body))).toEqual({ is_archived: false });
    expect(JSON.parse(String(patchCalls[1]?.body))).toEqual({ is_archived: true });
  });

  test("capture hook scopes recording and marks exact GETs before dispatch", () => {
    const hook = buildScopedBackendCaptureHook(
      "https://chatgpt.com/backend-api/conversation/conv-1",
    );
    expect(hook).toContain('const TARGET = "https://chatgpt.com/backend-api/conversation/conv-1"');
    expect(hook).toContain("url !== TARGET");
    expect(hook).toContain("window.fetch");
    expect(hook).toContain("requests: { started: 0, pending: 0, completed: 0 }");
    expect(hook.indexOf("state.requests.started += 1")).toBeLessThan(
      hook.indexOf("originalFetch.apply"),
    );
    expect(hook).toContain('request = begin("xhr", requestUrl, requestMethod, requestHeaders)');
    expect(hook).toContain("sessionStorage.setItem(STORAGE_KEY, capturedText)");
    expect(hook).toContain("state.cleanup");
    expect(hook).not.toContain("localStorage");
    expect(hook).not.toContain("cookie");
  });
  test("does not leave an ownerless persisted body when owner storage fails", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const payloadKey = `__oracleChatGptBackendCapture:${targetApiUrl}`;
    const ownerKey = `__oracleChatGptBackendCaptureOwner:${targetApiUrl}`;
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        if (key === ownerKey) throw new Error("owner storage unavailable");
        storageValues.set(key, value);
      }),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const originalFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ conversation_id: "conv-1", title: "private" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    class OriginalXhr {}
    const page = { fetch: originalFetch, XMLHttpRequest: OriginalXhr } as {
      fetch: typeof fetch;
      XMLHttpRequest: typeof OriginalXhr;
      __oracleChatGptBackendCapture?: {
        hits: Array<{ chars?: number }>;
      };
    };
    const install = new Function(
      "window",
      "location",
      "sessionStorage",
      buildScopedBackendCaptureHook(targetApiUrl, { owner: captureOwner }),
    ) as (window: typeof page, location: { href: string }, sessionStorage: typeof storage) => void;
    install(page, { href: "https://chatgpt.com/c/conv-1" }, storage);

    await page.fetch(targetApiUrl);
    await vi.waitFor(() => {
      expect(page.__oracleChatGptBackendCapture?.hits).toHaveLength(1);
    });

    expect(storageValues.get(payloadKey)).toBeUndefined();
    expect(storageValues.get(ownerKey)).toBeUndefined();
    expect(page.__oracleChatGptBackendCapture?.hits[0]?.chars).toBeGreaterThan(0);
  });

  test("cleans scoped capture state, removes its registration, and disarms delayed responses", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    let resolveResponse: ((response: Response) => void) | undefined;
    const originalFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    ) as unknown as typeof fetch;
    class OriginalXhr {}
    const page = {
      fetch: originalFetch,
      XMLHttpRequest: OriginalXhr,
      __oracleChatGptBackendCaptureSelection: { target: targetApiUrl, owner: captureOwner },
    } as {
      fetch: typeof fetch;
      XMLHttpRequest: typeof OriginalXhr;
      __oracleChatGptBackendCapture?: unknown;
      __oracleChatGptBackendCaptureSelection?: { target: string; owner: string };
    };
    const install = new Function(
      "window",
      "location",
      "sessionStorage",
      buildScopedBackendCaptureHook(targetApiUrl, { owner: captureOwner }),
    ) as (window: typeof page, location: { href: string }, sessionStorage: typeof storage) => void;
    install(page, { href: "https://chatgpt.com/c/conv-1" }, storage);

    const pendingResponse = page.fetch(targetApiUrl);
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: new Function("window", "sessionStorage", `return (${expression});`)(page, storage),
        },
      })),
    };
    const Page = { removeScriptToEvaluateOnNewDocument: vi.fn(async () => undefined) };

    await cleanupScopedBackendCaptureForTest(
      Runtime as never,
      Page as never,
      targetApiUrl,
      "scoped-capture-script",
      captureOwner,
    );

    expect(page.fetch).toBe(originalFetch);
    expect(page.XMLHttpRequest).toBe(OriginalXhr);
    expect(page.__oracleChatGptBackendCapture).toBeUndefined();
    expect(page.__oracleChatGptBackendCaptureSelection).toBeUndefined();
    expect(storage.getItem(`__oracleChatGptBackendCapture:${targetApiUrl}`)).toBeNull();
    expect(storage.getItem(`__oracleChatGptBackendCaptureOwner:${targetApiUrl}`)).toBeNull();
    expect(Page.removeScriptToEvaluateOnNewDocument).toHaveBeenCalledWith({
      identifier: "scoped-capture-script",
    });

    expect(resolveResponse).toBeTypeOf("function");
    resolveResponse!(
      new Response(JSON.stringify({ conversation_id: "conv-1", title: "delayed private body" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await pendingResponse;
    await Promise.resolve();
    await Promise.resolve();
    expect(storage.setItem).not.toHaveBeenCalledWith(
      `__oracleChatGptBackendCapture:${targetApiUrl}`,
      expect.any(String),
    );
  });

  test("accepts cleanup when another page wrapper superseded Oracle after capture", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const originalFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ conversation_id: "conv-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    class OriginalXhr {}
    const page = { fetch: originalFetch, XMLHttpRequest: OriginalXhr } as {
      fetch: typeof fetch;
      XMLHttpRequest: typeof OriginalXhr;
      __oracleChatGptBackendCapture?: unknown;
      __oracleChatGptBackendCaptureSelection?: unknown;
    };
    const install = new Function(
      "window",
      "location",
      "sessionStorage",
      buildScopedBackendCaptureHook(targetApiUrl, { owner: captureOwner }),
    ) as (window: typeof page, location: { href: string }, sessionStorage: typeof storage) => void;
    install(page, { href: "https://chatgpt.com/c/conv-1" }, storage);
    const oracleFetch = page.fetch;
    const laterFetch = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      oracleFetch(input, init),
    ) as unknown as typeof fetch;
    page.fetch = laterFetch;
    page.__oracleChatGptBackendCaptureSelection = {
      target: targetApiUrl,
      capture: page.__oracleChatGptBackendCapture,
    };
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: new Function("window", "sessionStorage", `return (${expression});`)(page, storage),
        },
      })),
    };
    const Page = { removeScriptToEvaluateOnNewDocument: vi.fn(async () => undefined) };

    await expect(
      cleanupScopedBackendCaptureForTest(
        Runtime as never,
        Page as never,
        targetApiUrl,
        "script",
        captureOwner,
      ),
    ).resolves.toBeUndefined();
    expect(page.fetch).toBe(laterFetch);
    expect(page.XMLHttpRequest).toBe(OriginalXhr);
    expect(page.__oracleChatGptBackendCapture).toBeUndefined();
    expect(page.__oracleChatGptBackendCaptureSelection).toBeUndefined();

    storage.setItem.mockClear();
    await page.fetch(targetApiUrl);
    await Promise.resolve();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test("does not tear down a same-target capture owned by another run", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const foreignOwner = "foreign-capture-owner";
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const originalFetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    class OriginalXhr {}
    const page = {
      fetch: originalFetch,
      XMLHttpRequest: OriginalXhr,
      __oracleChatGptBackendCaptureSelection: { target: targetApiUrl, owner: foreignOwner },
    } as {
      fetch: typeof fetch;
      XMLHttpRequest: typeof OriginalXhr;
      __oracleChatGptBackendCapture?: { owner?: string; active?: boolean };
      __oracleChatGptBackendCaptureSelection?: { target: string; owner: string };
    };
    const install = new Function(
      "window",
      "location",
      "sessionStorage",
      buildScopedBackendCaptureHook(targetApiUrl, { owner: foreignOwner }),
    ) as (window: typeof page, location: { href: string }, sessionStorage: typeof storage) => void;
    install(page, { href: "https://chatgpt.com/c/conv-1" }, storage);
    const foreignCapture = page.__oracleChatGptBackendCapture;
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: new Function("window", "sessionStorage", `return (${expression});`)(page, storage),
        },
      })),
    };
    const Page = { removeScriptToEvaluateOnNewDocument: vi.fn(async () => undefined) };

    await expect(
      cleanupScopedBackendCaptureForTest(
        Runtime as never,
        Page as never,
        targetApiUrl,
        "capture-script",
        captureOwner,
      ),
    ).resolves.toBeUndefined();
    expect(page.__oracleChatGptBackendCapture).toBe(foreignCapture);
    expect(page.__oracleChatGptBackendCapture).toMatchObject({ owner: foreignOwner, active: true });
    expect(page.fetch).not.toBe(originalFetch);
    expect(page.__oracleChatGptBackendCaptureSelection).toEqual({
      target: targetApiUrl,
      owner: foreignOwner,
    });
    expect(storage.getItem(`__oracleChatGptBackendCaptureDisabled:v2:${targetApiUrl}`)).toBeNull();
    await expect(
      cleanupScopedBackendCaptureForTest(
        Runtime as never,
        Page as never,
        targetApiUrl,
        "foreign-capture-script",
        foreignOwner,
      ),
    ).resolves.toBeUndefined();
    expect(page.__oracleChatGptBackendCapture).toBeUndefined();
    expect(page.fetch).toBe(originalFetch);
    expect(page.XMLHttpRequest).toBe(OriginalXhr);
    expect(page.__oracleChatGptBackendCaptureSelection).toBeUndefined();
    expect(storage.getItem(`__oracleChatGptBackendCaptureDisabled:v2:${targetApiUrl}`)).toBeNull();
    expect(Page.removeScriptToEvaluateOnNewDocument).toHaveBeenCalledTimes(2);
  });

  test("retains a foreign orphan selection and payload during cleanup", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const foreignOwner = "foreign-orphan-owner";
    const payloadKey = `__oracleChatGptBackendCapture:${targetApiUrl}`;
    const ownerKey = `__oracleChatGptBackendCaptureOwner:${targetApiUrl}`;
    const storageValues = new Map<string, string>([
      [payloadKey, JSON.stringify({ conversation_id: "conv-1", title: "foreign" })],
      [ownerKey, foreignOwner],
    ]);
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const page = {
      fetch: vi.fn(async () => new Response("{}")),
      XMLHttpRequest: class {},
      __oracleChatGptBackendCaptureSelection: {
        target: targetApiUrl,
        owner: foreignOwner,
        text: "foreign private body",
      },
    } as {
      fetch: typeof fetch;
      XMLHttpRequest: new () => object;
      __oracleChatGptBackendCaptureSelection?: { target: string; owner: string; text: string };
    };
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: new Function("window", "sessionStorage", `return (${expression});`)(page, storage),
        },
      })),
    };
    const Page = { removeScriptToEvaluateOnNewDocument: vi.fn(async () => undefined) };

    await expect(
      cleanupScopedBackendCaptureForTest(
        Runtime as never,
        Page as never,
        targetApiUrl,
        "capture-script",
        captureOwner,
      ),
    ).rejects.toMatchObject({
      details: { code: "capture-cleanup-failed", cleanup: ["page cleanup"] },
    });
    expect(page.__oracleChatGptBackendCaptureSelection).toEqual({
      target: targetApiUrl,
      owner: foreignOwner,
      text: "foreign private body",
    });
    expect(storage.getItem(payloadKey)).toContain('"title":"foreign"');
    expect(storage.getItem(ownerKey)).toBe(foreignOwner);
    expect(storage.getItem(`__oracleChatGptBackendCaptureDisabled:v2:${targetApiUrl}`)).toBe(
      captureOwner,
    );
  });

  test("rejects cleanup when Oracle's fetch wrapper remains current", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const originalFetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    class OriginalXhr {}
    const page = { fetch: originalFetch, XMLHttpRequest: OriginalXhr } as {
      fetch: typeof fetch;
      XMLHttpRequest: typeof OriginalXhr;
      __oracleChatGptBackendCapture?: {
        active: boolean;
        hits: Array<{ text?: string }>;
      };
    };
    const install = new Function(
      "window",
      "location",
      "sessionStorage",
      buildScopedBackendCaptureHook(targetApiUrl, { owner: captureOwner }),
    ) as (window: typeof page, location: { href: string }, sessionStorage: typeof storage) => void;
    install(page, { href: "https://chatgpt.com/c/conv-1" }, storage);
    page.__oracleChatGptBackendCapture!.hits.push({ text: "private body" });
    const oracleFetch = page.fetch;
    Object.defineProperty(page, "fetch", {
      configurable: true,
      get: () => oracleFetch,
      set: () => undefined,
    });
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: new Function("window", "sessionStorage", `return (${expression});`)(page, storage),
        },
      })),
    };
    const Page = { removeScriptToEvaluateOnNewDocument: vi.fn(async () => undefined) };

    await expect(
      cleanupScopedBackendCaptureForTest(
        Runtime as never,
        Page as never,
        targetApiUrl,
        "script",
        captureOwner,
      ),
    ).rejects.toMatchObject({
      details: { code: "capture-cleanup-failed", cleanup: ["page cleanup"] },
    });
    expect(page.__oracleChatGptBackendCapture?.hits).toEqual([]);
    expect(page.__oracleChatGptBackendCapture?.active).toBe(false);
  });

  test("accepts missing new-document registration as already removed", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const Runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          result: { value: { owned: true, preExisting: false, retained: true } },
        })
        .mockResolvedValueOnce({
          result: { value: { owned: true, preExisting: true, retained: true } },
        })
        .mockResolvedValueOnce({
          result: {
            value: {
              markerOwned: true,
              ownerMatched: true,
              matched: true,
              deactivated: true,
              restoredFetch: true,
              restoredXMLHttpRequest: true,
              stateRemoved: true,
              selectionRemoved: true,
              storageRemoved: true,
              payloadCleared: true,
            },
          },
        })
        .mockResolvedValueOnce({ result: { value: true } }),
    };
    const Page = {
      removeScriptToEvaluateOnNewDocument: vi
        .fn()
        .mockRejectedValue(new Error('{"code":-32000,"message":"Script not found"}')),
    };

    await expect(
      cleanupScopedBackendCaptureForTest(
        Runtime as never,
        Page as never,
        targetApiUrl,
        "script",
        captureOwner,
      ),
    ).resolves.toBeUndefined();
  });
  test("rejects cleanup when the new-document registration outcome is unknown", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const disabledKey = `__oracleChatGptBackendCaptureDisabled:v2:${targetApiUrl}`;
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const originalFetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    class OriginalXhr {}
    const page = {
      fetch: originalFetch,
      XMLHttpRequest: OriginalXhr,
    } as {
      fetch: typeof fetch;
      XMLHttpRequest: typeof OriginalXhr;
      __oracleChatGptBackendCapture?: unknown;
    };
    const install = new Function(
      "window",
      "location",
      "sessionStorage",
      buildScopedBackendCaptureHook(targetApiUrl, { owner: captureOwner }),
    ) as (window: typeof page, location: { href: string }, sessionStorage: typeof storage) => void;
    install(page, { href: "https://chatgpt.com/c/conv-1" }, storage);
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: new Function("window", "sessionStorage", `return (${expression});`)(page, storage),
        },
      })),
    };
    const Page = { removeScriptToEvaluateOnNewDocument: vi.fn(async () => undefined) };

    await expect(
      cleanupScopedBackendCaptureForTest(
        Runtime as never,
        Page as never,
        targetApiUrl,
        undefined,
        captureOwner,
        true,
      ),
    ).rejects.toMatchObject({
      details: {
        code: "capture-cleanup-failed",
        cleanup: expect.arrayContaining(["script registration unverified"]),
      },
    });
    expect(Page.removeScriptToEvaluateOnNewDocument).not.toHaveBeenCalled();
    expect(storage.getItem(disabledKey)).toBe(captureOwner);
    expect(page.__oracleChatGptBackendCapture).toBeUndefined();
  });

  test.each([
    ["message only", new Error("Script not found")],
    ["wrong code", new Error('{"code":-32001,"message":"Script not found"}')],
    ["wrong message", new Error('{"code":-32000,"message":"script not found"}')],
  ])("rejects a non-exact missing-registration error: %s", async (_label, removalError) => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const Runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          result: { value: { owned: true, preExisting: false, retained: true } },
        })
        .mockResolvedValueOnce({
          result: { value: { owned: true, preExisting: true, retained: true } },
        })
        .mockResolvedValueOnce({
          result: {
            value: {
              markerOwned: true,
              ownerMatched: true,
              matched: true,
              deactivated: true,
              restoredFetch: true,
              restoredXMLHttpRequest: true,
              stateRemoved: true,
              selectionRemoved: true,
              storageRemoved: true,
              payloadCleared: true,
            },
          },
        })
        .mockResolvedValueOnce({
          result: { value: { owned: true, preExisting: true, retained: true } },
        }),
    };
    const Page = {
      removeScriptToEvaluateOnNewDocument: vi.fn().mockRejectedValue(removalError),
    };

    await expect(
      cleanupScopedBackendCaptureForTest(
        Runtime as never,
        Page as never,
        targetApiUrl,
        "script",
        captureOwner,
      ),
    ).rejects.toMatchObject({
      details: {
        code: "capture-cleanup-failed",
        cleanup: expect.arrayContaining(["script removal"]),
      },
    });
  });

  test("recovers a transient page cleanup failure after registration removal", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const captureResult = (stateRemoved: boolean, matched = true) => ({
      result: {
        value: {
          markerOwned: true,
          ownerMatched: true,
          matched,
          deactivated: true,
          restoredFetch: true,
          restoredXMLHttpRequest: true,
          stateRemoved,
          selectionRemoved: true,
          storageRemoved: true,
          payloadCleared: true,
        },
      },
    });
    const Runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          result: { value: { owned: true, preExisting: false, retained: true } },
        })
        .mockResolvedValueOnce({
          result: { value: { owned: true, preExisting: true, retained: true } },
        })
        .mockResolvedValueOnce(captureResult(false))
        .mockResolvedValueOnce({
          result: { value: { owned: true, preExisting: true, retained: true } },
        })
        .mockResolvedValueOnce(captureResult(true))
        .mockResolvedValueOnce({ result: { value: true } }),
    };
    let registered = true;
    const Page = {
      removeScriptToEvaluateOnNewDocument: vi.fn(async () => {
        if (!registered) {
          throw Object.assign(new Error("Script not found"), {
            response: { code: -32_000, message: "Script not found" },
          });
        }
        registered = false;
      }),
    };

    await expect(
      cleanupScopedBackendCaptureForTest(
        Runtime as never,
        Page as never,
        targetApiUrl,
        "script",
        captureOwner,
      ),
    ).resolves.toBeUndefined();
    expect(registered).toBe(false);
    expect(Page.removeScriptToEvaluateOnNewDocument).toHaveBeenCalledTimes(1);
    expect(Runtime.evaluate).toHaveBeenCalledTimes(6);
  });

  test("clears its marker when an already-removed registration has no current capture state", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const page = { XMLHttpRequest: class {}, fetch: vi.fn() };
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: new Function("window", "sessionStorage", `return (${expression});`)(page, storage),
        },
      })),
    };
    const Page = {
      removeScriptToEvaluateOnNewDocument: vi
        .fn()
        .mockRejectedValue(new Error('{"code":-32000,"message":"Script not found"}')),
    };

    await cleanupScopedBackendCaptureForTest(
      Runtime as never,
      Page as never,
      targetApiUrl,
      "capture-id",
      captureOwner,
    );

    expect(Runtime.evaluate).toHaveBeenCalledTimes(4);
  });

  test("does not tear down page state when marker ownership and registration removal both fail", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const Runtime = { evaluate: vi.fn().mockRejectedValue(new Error("marker unavailable")) };
    const Page = {
      removeScriptToEvaluateOnNewDocument: vi.fn().mockRejectedValue(new Error("remove failed")),
    };

    await expect(
      cleanupScopedBackendCaptureForTest(
        Runtime as never,
        Page as never,
        targetApiUrl,
        "capture-id",
        captureOwner,
      ),
    ).rejects.toMatchObject({
      details: { cleanup: expect.arrayContaining(["fail-closed marker", "script removal"]) },
    });
    expect(Runtime.evaluate).toHaveBeenCalledTimes(3);
  });
  test("contains capture state after registration removal when marker storage cannot be armed", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const originalFetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    class OriginalXhr {}
    const page = {
      fetch: originalFetch,
      XMLHttpRequest: OriginalXhr,
    } as {
      fetch: typeof fetch;
      XMLHttpRequest: typeof OriginalXhr;
      __oracleChatGptBackendCapture?: unknown;
    };
    const install = new Function(
      "window",
      "location",
      "sessionStorage",
      buildScopedBackendCaptureHook(targetApiUrl, { owner: captureOwner }),
    ) as (window: typeof page, location: { href: string }, sessionStorage: typeof storage) => void;
    install(page, { href: "https://chatgpt.com/c/conv-1" }, storage);
    let evaluateCalls = 0;
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        evaluateCalls += 1;
        if ([1, 2, 4].includes(evaluateCalls)) {
          throw new Error("marker unavailable");
        }
        return {
          result: {
            value: new Function("window", "sessionStorage", `return (${expression});`)(
              page,
              storage,
            ),
          },
        };
      }),
    };
    const Page = { removeScriptToEvaluateOnNewDocument: vi.fn(async () => undefined) };

    await expect(
      cleanupScopedBackendCaptureForTest(
        Runtime as never,
        Page as never,
        targetApiUrl,
        "capture-id",
        captureOwner,
      ),
    ).rejects.toMatchObject({
      details: { cleanup: expect.arrayContaining(["fail-closed marker"]) },
    });
    expect(page.fetch).toBe(originalFetch);
    expect(page.XMLHttpRequest).toBe(OriginalXhr);
    expect(page.__oracleChatGptBackendCapture).toBeUndefined();
    expect(storage.getItem(`__oracleChatGptBackendCapture:${targetApiUrl}`)).toBeNull();
    expect(evaluateCalls).toBe(5);
  });

  test("cleans archived recovery state and removes its registration", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const storageValues = new Map<string, string>();
    const originalFetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const page = {
      fetch: originalFetch,
      document: { getElementById: () => ({ textContent: "{}" }) },
    } as {
      fetch: typeof fetch;
      document: { getElementById: () => { textContent: string } };
      __oracleArchivedConversationRecovery?: unknown;
    };
    const install = new Function(
      "window",
      "document",
      "location",
      "Request",
      "Headers",
      "URL",
      "crypto",
      "TextEncoder",
      "globalThis",
      "sessionStorage",
      buildArchivedConversationRecoveryHookForTest("conv-1", { owner: archiveOwner }),
    ) as (...args: unknown[]) => void;
    install(
      page,
      page.document,
      { href: "https://chatgpt.com/#settings/DataControls/ArchivedChats" },
      Request,
      Headers,
      URL,
      globalThis.crypto,
      TextEncoder,
      { crypto: globalThis.crypto },
      storage,
    );
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: new Function("window", "sessionStorage", `return (${expression});`)(page, storage),
        },
      })),
    };
    const Page = { removeScriptToEvaluateOnNewDocument: vi.fn(async () => undefined) };

    await cleanupArchivedConversationRecoveryForTest(
      Runtime as never,
      Page as never,
      targetApiUrl,
      "archive-recovery-script",
      archiveOwner,
    );

    expect(page.fetch).toBe(originalFetch);
    expect(page.__oracleArchivedConversationRecovery).toBeUndefined();
    expect(storage.removeItem).toHaveBeenCalledWith(
      `__oracleArchivedConversationRecoveryDisabled:v2:${targetApiUrl}`,
    );
    expect(Page.removeScriptToEvaluateOnNewDocument).toHaveBeenCalledWith({
      identifier: "archive-recovery-script",
    });
  });
  test("preserves legacy marker sentinels while using v2 cleanup markers", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const legacyKey = `__oracleChatGptBackendCaptureDisabled:${targetApiUrl}`;
    const v2Key = `__oracleChatGptBackendCaptureDisabled:v2:${targetApiUrl}`;
    const storageValues = new Map<string, string>([[legacyKey, "1"]]);
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const originalFetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    class OriginalXhr {}
    const page = { fetch: originalFetch, XMLHttpRequest: OriginalXhr } as {
      fetch: typeof fetch;
      XMLHttpRequest: typeof OriginalXhr;
      __oracleChatGptBackendCapture?: { version?: number; owner?: string; active?: boolean };
    };
    const install = new Function(
      "window",
      "location",
      "sessionStorage",
      buildScopedBackendCaptureHook(targetApiUrl, { owner: captureOwner }),
    ) as (window: typeof page, location: { href: string }, sessionStorage: typeof storage) => void;
    install(page, { href: "https://chatgpt.com/c/conv-1" }, storage);
    expect(page.__oracleChatGptBackendCapture).toMatchObject({
      version: 2,
      owner: captureOwner,
      active: true,
    });
    expect(storage.getItem(legacyKey)).toBe("1");
    expect(storage.getItem(v2Key)).toBeNull();
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: new Function("window", "sessionStorage", `return (${expression});`)(page, storage),
        },
      })),
    };
    const Page = { removeScriptToEvaluateOnNewDocument: vi.fn(async () => undefined) };
    await cleanupScopedBackendCaptureForTest(
      Runtime as never,
      Page as never,
      targetApiUrl,
      "capture-v2-script",
      captureOwner,
    );
    expect(page.__oracleChatGptBackendCapture).toBeUndefined();
    expect(page.fetch).toBe(originalFetch);
    expect(storage.getItem(legacyKey)).toBe("1");
    expect(storage.getItem(v2Key)).toBeNull();
  });
  test("preserves the legacy archive marker sentinel while using its v2 cleanup marker", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const legacyKey = `__oracleArchivedConversationRecoveryDisabled:${targetApiUrl}`;
    const v2Key = `__oracleArchivedConversationRecoveryDisabled:v2:${targetApiUrl}`;
    const storageValues = new Map<string, string>([[legacyKey, "1"]]);
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const originalFetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const page = {
      fetch: originalFetch,
      document: { getElementById: () => ({ textContent: "{}" }) },
    } as {
      fetch: typeof fetch;
      document: { getElementById: () => { textContent: string } };
      __oracleArchivedConversationRecovery?: unknown;
    };
    const install = new Function(
      "window",
      "document",
      "location",
      "Request",
      "Headers",
      "URL",
      "crypto",
      "TextEncoder",
      "globalThis",
      "sessionStorage",
      buildArchivedConversationRecoveryHookForTest("conv-1", { owner: archiveOwner }),
    ) as (...args: unknown[]) => void;
    install(
      page,
      page.document,
      { href: "https://chatgpt.com/#settings/DataControls/ArchivedChats" },
      Request,
      Headers,
      URL,
      globalThis.crypto,
      TextEncoder,
      { crypto: globalThis.crypto },
      storage,
    );
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: new Function("window", "sessionStorage", `return (${expression});`)(page, storage),
        },
      })),
    };
    const Page = { removeScriptToEvaluateOnNewDocument: vi.fn(async () => undefined) };

    await cleanupArchivedConversationRecoveryForTest(
      Runtime as never,
      Page as never,
      targetApiUrl,
      "archive-v2-script",
      archiveOwner,
    );

    expect(page.__oracleArchivedConversationRecovery).toBeUndefined();
    expect(page.fetch).toBe(originalFetch);
    expect(storage.getItem(legacyKey)).toBe("1");
    expect(storage.getItem(v2Key)).toBeNull();
    expect(storage.setItem).toHaveBeenCalledWith(legacyKey, "1");
    expect(storage.removeItem).not.toHaveBeenCalledWith(legacyKey);
  });

  test("replaces legacy same-target capture state without consuming its hit", () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const legacyKey = `__oracleChatGptBackendCaptureDisabled:${targetApiUrl}`;
    const storageValues = new Map<string, string>([[legacyKey, "1"]]);
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const legacyOriginalFetch = vi.fn() as unknown as typeof fetch;
    const legacyFetchWrapper = vi.fn() as unknown as typeof fetch;
    class LegacyOriginalXhr {}
    class LegacyXhrWrapper {}
    const legacyState = {
      target: targetApiUrl,
      active: true,
      originalFetch: legacyOriginalFetch,
      fetchWrapper: legacyFetchWrapper,
      originalXMLHttpRequest: LegacyOriginalXhr,
      xmlHttpRequestWrapper: LegacyXhrWrapper,
      hits: [
        { url: targetApiUrl, status: 200, text: JSON.stringify({ conversation_id: "conv-1" }) },
      ],
      cleanup: vi.fn(),
    };
    const page = {
      fetch: legacyFetchWrapper,
      XMLHttpRequest: LegacyXhrWrapper,
      __oracleChatGptBackendCapture: legacyState,
      __oracleChatGptBackendCaptureSelection: {
        target: targetApiUrl,
        capture: legacyState,
        text: "legacy private body",
      },
    } as {
      fetch: typeof fetch;
      XMLHttpRequest: typeof LegacyXhrWrapper;
      __oracleChatGptBackendCapture?: typeof legacyState;
      __oracleChatGptBackendCaptureSelection?: {
        target: string;
        capture: typeof legacyState;
        text: string;
      };
    };
    const install = new Function(
      "window",
      "location",
      "sessionStorage",
      buildScopedBackendCaptureHook(targetApiUrl, { owner: captureOwner }),
    ) as (window: typeof page, location: { href: string }, sessionStorage: typeof storage) => void;

    install(page, { href: "https://chatgpt.com/c/conv-1" }, storage);

    expect(legacyState.cleanup).not.toHaveBeenCalled();
    expect(legacyState.active).toBe(false);
    expect(legacyState.hits).toEqual([]);
    expect(page.__oracleChatGptBackendCapture).toMatchObject({
      version: 2,
      owner: captureOwner,
      target: targetApiUrl,
      active: true,
    });
    expect(page.__oracleChatGptBackendCapture).not.toBe(legacyState);
    expect(page.__oracleChatGptBackendCaptureSelection).toBeUndefined();
    expect(storage.getItem(legacyKey)).toBe("1");
  });

  test("replaces legacy same-target archive state without trusting its recovery result", () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const legacyKey = `__oracleArchivedConversationRecoveryDisabled:${targetApiUrl}`;
    const storageValues = new Map<string, string>([[legacyKey, "1"]]);
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const legacyOriginalFetch = vi.fn() as unknown as typeof fetch;
    const legacyFetchWrapper = vi.fn() as unknown as typeof fetch;
    const legacyState = {
      target: targetApiUrl,
      active: true,
      originalFetch: legacyOriginalFetch,
      fetchWrapper: legacyFetchWrapper,
      status: "recovered",
      recovered: true,
      cleanup: vi.fn(),
    };
    const page = {
      fetch: legacyFetchWrapper,
      document: { getElementById: () => ({ textContent: "{}" }) },
      __oracleArchivedConversationRecovery: legacyState,
    } as {
      fetch: typeof fetch;
      document: { getElementById: () => { textContent: string } };
      __oracleArchivedConversationRecovery?: typeof legacyState;
    };
    const install = new Function(
      "window",
      "document",
      "location",
      "Request",
      "Headers",
      "URL",
      "crypto",
      "TextEncoder",
      "globalThis",
      "sessionStorage",
      buildArchivedConversationRecoveryHookForTest("conv-1", { owner: archiveOwner }),
    ) as (...args: unknown[]) => void;

    install(
      page,
      page.document,
      { href: "https://chatgpt.com/#settings/DataControls/ArchivedChats" },
      Request,
      Headers,
      URL,
      globalThis.crypto,
      TextEncoder,
      { crypto: globalThis.crypto },
      storage,
    );

    expect(legacyState.cleanup).not.toHaveBeenCalled();
    expect(legacyState.active).toBe(false);
    expect(page.__oracleArchivedConversationRecovery).toMatchObject({
      version: 2,
      owner: archiveOwner,
      target: targetApiUrl,
      active: true,
    });
    expect(page.__oracleArchivedConversationRecovery).not.toBe(legacyState);
    expect(storage.getItem(legacyKey)).toBe("1");
  });

  test("rejects legacy and foreign capture state before polling or retrieving its body", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const approved = JSON.stringify({ conversation_id: "conv-1", title: "private" });
    for (const state of [
      { version: 1, owner: "legacy-owner" },
      { version: 2, owner: "foreign-owner" },
    ]) {
      const evaluator = vi.fn(
        async (expression: string) =>
          new Function("window", "sessionStorage", `return (${expression})`)(
            {
              __oracleChatGptBackendCapture: {
                target: targetApiUrl,
                version: state.version,
                owner: state.owner,
                hits: [{ url: targetApiUrl, status: 200, text: approved }],
                requests: { started: 1, pending: 0, completed: 1 },
              },
            },
            { getItem: () => approved },
          ) as never,
      );
      const fallback = vi.fn(async () => true);

      await expect(
        pollCaptureWithPassiveFallbackForTest(
          evaluator,
          targetApiUrl,
          1_000,
          0,
          fallback,
          undefined,
          captureOwner,
        ),
      ).rejects.toThrow(/capture hook owner or version changed/i);
      expect(fallback).not.toHaveBeenCalled();
      await expect(
        retrieveCapturedTextWithEvaluator(
          evaluator,
          targetApiUrl,
          approved.length,
          approved.length,
          Date.now() + 25,
          captureOwner,
        ),
      ).rejects.toThrow(
        /timed out waiting for backend conversation capture|missing captured text chunk/i,
      );
      expect(evaluator).toHaveBeenCalled();
    }
  });

  test("reports marker and registration failures without unguarded page teardown", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const Runtime = { evaluate: vi.fn().mockRejectedValue(new Error("page disconnected")) };
    const Page = {
      removeScriptToEvaluateOnNewDocument: vi.fn().mockRejectedValue(new Error("remove failed")),
    };

    await expect(
      cleanupScopedBackendCaptureForTest(
        Runtime as never,
        Page as never,
        targetApiUrl,
        "script-id",
        captureOwner,
      ),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: {
        code: "capture-cleanup-failed",
        cleanup: expect.arrayContaining(["script removal", "fail-closed marker"]),
      },
    });
    expect(Page.removeScriptToEvaluateOnNewDocument).toHaveBeenCalledWith({
      identifier: "script-id",
    });
    expect(Runtime.evaluate).toHaveBeenCalledTimes(3);
  });

  test("blocks hook installation while removing the new-document registration", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const originalFetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    class OriginalXhr {}
    const page = { fetch: originalFetch, XMLHttpRequest: OriginalXhr } as {
      fetch: typeof fetch;
      XMLHttpRequest: typeof OriginalXhr;
      __oracleChatGptBackendCapture?: unknown;
    };
    const install = new Function(
      "window",
      "location",
      "sessionStorage",
      buildScopedBackendCaptureHook(targetApiUrl, { owner: captureOwner }),
    ) as (window: typeof page, location: { href: string }, sessionStorage: typeof storage) => void;
    install(page, { href: "https://chatgpt.com/c/conv-1" }, storage);
    let currentPage = page;
    const events: string[] = [];
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        events.push(Runtime.evaluate.mock.calls.length === 1 ? "marker" : "page-or-clear");
        return {
          result: {
            value: new Function("window", "sessionStorage", `return (${expression});`)(
              currentPage,
              storage,
            ),
          },
        };
      }),
    };
    let navigatedPage: typeof page | undefined;
    const Page = {
      removeScriptToEvaluateOnNewDocument: vi.fn(async () => {
        events.push("remove");
        navigatedPage = { fetch: originalFetch, XMLHttpRequest: OriginalXhr };
        currentPage = navigatedPage;
        install(currentPage, { href: "https://chatgpt.com/c/conv-1" }, storage);
      }),
    };

    await cleanupScopedBackendCaptureForTest(
      Runtime as never,
      Page as never,
      targetApiUrl,
      "capture-id",
      captureOwner,
    );

    expect(events).toEqual(["marker", "remove", "page-or-clear", "page-or-clear", "page-or-clear"]);
    expect(navigatedPage?.__oracleChatGptBackendCapture).toBeUndefined();
    expect(storage.getItem(`__oracleChatGptBackendCaptureDisabled:v2:${targetApiUrl}`)).toBeNull();
  });

  test("retains a stale marker when the original registration cannot be removed", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const disabledKey = `__oracleChatGptBackendCaptureDisabled:v2:${targetApiUrl}`;
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const originalFetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    class OriginalXhr {}
    const page = {
      fetch: originalFetch,
      XMLHttpRequest: OriginalXhr,
    } as {
      fetch: typeof fetch;
      XMLHttpRequest: typeof OriginalXhr;
      __oracleChatGptBackendCapture?: unknown;
      __oracleChatGptBackendCaptureSelection?: unknown;
    };
    const install = new Function(
      "window",
      "location",
      "sessionStorage",
      buildScopedBackendCaptureHook(targetApiUrl, { owner: "id-a" }),
    ) as (window: typeof page, location: { href: string }, sessionStorage: typeof storage) => void;
    install(page, { href: "https://chatgpt.com/c/conv-1" }, storage);
    let removeCalls = 0;
    const Page = {
      removeScriptToEvaluateOnNewDocument: vi.fn(async () => {
        removeCalls += 1;
        if (removeCalls === 1) throw new Error("registration removal failed");
      }),
    };
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: new Function("window", "sessionStorage", `return (${expression});`)(page, storage),
        },
      })),
    };

    await expect(
      cleanupScopedBackendCaptureForTest(
        Runtime as never,
        Page as never,
        targetApiUrl,
        "id-a",
        "id-a",
      ),
      "id-a",
    ).rejects.toMatchObject({
      details: { cleanup: expect.arrayContaining(["script removal"]) },
    });
    expect(storage.getItem(disabledKey)).toBe("id-a");
    expect(
      storage.getItem(`__oracleArchivedConversationRecoveryDisabled:v2:${targetApiUrl}`),
    ).toBeNull();

    install(page, { href: "https://chatgpt.com/c/conv-1" }, storage);
    expect(page.__oracleChatGptBackendCapture).toBeUndefined();

    await expect(
      cleanupScopedBackendCaptureForTest(
        Runtime as never,
        Page as never,
        targetApiUrl,
        "id-b",
        "id-b",
      ),
    ).rejects.toMatchObject({
      details: { cleanup: expect.arrayContaining(["pre-existing fail-closed marker"]) },
    });
    expect(storage.getItem(disabledKey)).toBe("id-a");
    install(page, { href: "https://chatgpt.com/c/conv-1" }, storage);
    expect(page.__oracleChatGptBackendCapture).toBeUndefined();
  });

  test("does not let a capture marker disable archived recovery", () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const storageValues = new Map<string, string>([
      [`__oracleChatGptBackendCaptureDisabled:v2:${targetApiUrl}`, "capture-id"],
      [`__oracleArchivedConversationRecoveryDisabled:${targetApiUrl}`, "1"],
    ]);
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => storageValues.set(key, value),
      removeItem: (key: string) => storageValues.delete(key),
    };
    const page = {
      fetch: vi.fn(async () => new Response("{}")),
      document: { getElementById: () => ({ textContent: "{}" }) },
    } as {
      fetch: typeof fetch;
      document: { getElementById: () => { textContent: string } };
      __oracleArchivedConversationRecovery?: unknown;
    };
    const install = new Function(
      "window",
      "document",
      "location",
      "Request",
      "Headers",
      "URL",
      "crypto",
      "TextEncoder",
      "globalThis",
      "sessionStorage",
      buildArchivedConversationRecoveryHookForTest("conv-1"),
    ) as (...args: unknown[]) => void;
    install(
      page,
      page.document,
      { href: "https://chatgpt.com/#settings/DataControls/ArchivedChats" },
      Request,
      Headers,
      URL,
      globalThis.crypto,
      TextEncoder,
      { crypto: globalThis.crypto },
      storage,
    );
    expect(page.__oracleArchivedConversationRecovery).toBeDefined();
  });

  test("blocks archived recovery installation while removing its registration", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
      removeItem: vi.fn((key: string) => storageValues.delete(key)),
    };
    const originalFetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const page = {
      fetch: originalFetch,
      document: { getElementById: () => ({ textContent: "{}" }) },
    } as {
      fetch: typeof fetch;
      document: { getElementById: () => { textContent: string } };
      __oracleArchivedConversationRecovery?: unknown;
    };
    const install = new Function(
      "window",
      "document",
      "location",
      "Request",
      "Headers",
      "URL",
      "crypto",
      "TextEncoder",
      "globalThis",
      "sessionStorage",
      buildArchivedConversationRecoveryHookForTest("conv-1", { owner: archiveOwner }),
    ) as (...args: unknown[]) => void;
    const installOn = (target: typeof page) =>
      install(
        target,
        target.document,
        { href: "https://chatgpt.com/#settings/DataControls/ArchivedChats" },
        Request,
        Headers,
        URL,
        globalThis.crypto,
        TextEncoder,
        { crypto: globalThis.crypto },
        storage,
      );
    installOn(page);
    let currentPage = page;
    const Runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: new Function("window", "sessionStorage", `return (${expression});`)(
            currentPage,
            storage,
          ),
        },
      })),
    };
    let navigatedPage: typeof page | undefined;
    const Page = {
      removeScriptToEvaluateOnNewDocument: vi.fn(async () => {
        navigatedPage = {
          fetch: originalFetch,
          document: page.document,
        };
        currentPage = navigatedPage;
        installOn(currentPage);
      }),
    };

    await cleanupArchivedConversationRecoveryForTest(
      Runtime as never,
      Page as never,
      targetApiUrl,
      "archive-id",
      archiveOwner,
    );

    expect(navigatedPage?.__oracleArchivedConversationRecovery).toBeUndefined();
    expect(
      storage.getItem(`__oracleArchivedConversationRecoveryDisabled:v2:${targetApiUrl}`),
    ).toBeNull();
  });

  test("captures approved JSON XHR responses without reading responseText", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const payload = { conversation_id: "conv-1", title: "approved" };
    class FakeXhr {
      responseType = "json";
      response: unknown = payload;
      status = 200;
      private readonly listeners = new Map<string, () => void>();

      get responseText(): string {
        throw new Error("InvalidStateError");
      }

      open(_method: string, _url: string): void {}
      send(): void {
        this.listeners.get("loadend")?.();
      }

      addEventListener(name: string, listener: () => void): void {
        this.listeners.set(name, listener);
      }

      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === "content-type" ? "application/json" : null;
      }
    }
    const page: {
      fetch: ReturnType<typeof vi.fn>;
      XMLHttpRequest: new () => FakeXhr;
      __oracleChatGptBackendCapture?: {
        hits: Array<{ text?: string; status?: number }>;
        requests: { started: number; pending: number; completed: number };
      };
    } = {
      fetch: vi.fn(),
      XMLHttpRequest: FakeXhr,
    };
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    const install = new Function(
      "window",
      "location",
      "sessionStorage",
      buildScopedBackendCaptureHook(targetApiUrl),
    ) as (window: typeof page, location: { href: string }, sessionStorage: typeof storage) => void;
    install(page, { href: "https://chatgpt.com/c/conv-1" }, storage);

    const xhr = new page.XMLHttpRequest();
    xhr.open("GET", targetApiUrl);
    xhr.send();
    await vi.waitFor(() => {
      expect(page.__oracleChatGptBackendCapture?.requests.completed).toBe(1);
    });

    const text = JSON.stringify(payload);
    expect(page.__oracleChatGptBackendCapture).toMatchObject({
      hits: [{ status: 200, text }],
      requests: { started: 1, pending: 0, completed: 1 },
    });
    expect(storage.setItem).toHaveBeenCalledWith(
      `__oracleChatGptBackendCapture:${targetApiUrl}`,
      text,
    );
  });
  test("resets tracked headers when a reused XHR opens a new request", async () => {
    const targetUrl = "https://chatgpt.com/c/conv-1";
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const userId = "account-a";
    const workspaceId = "workspace-a";
    const payload = JSON.stringify({ conversation_id: "conv-1", title: "approved" });
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    class FakeXhr {
      responseType = "";
      responseText = payload;
      status = 200;
      private readonly listeners = new Map<string, () => void>();

      open(_method: string, _url: string): void {}
      setRequestHeader(_name: string, _value: string): void {}
      send(): void {
        this.listeners.get("loadend")?.();
      }
      addEventListener(name: string, listener: () => void): void {
        this.listeners.set(name, listener);
      }
      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === "content-type" ? "application/json" : null;
      }
    }
    const pageFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/auth/session") {
        return new Response(
          JSON.stringify({ user: { id: userId }, account: { id: workspaceId } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const page = {
      fetch: pageFetch as unknown as typeof fetch,
      XMLHttpRequest: FakeXhr,
      document: {
        getElementById: () => ({
          textContent: JSON.stringify({
            session: {
              user: { id: userId },
              account: { id: workspaceId },
              accessToken: "fresh-account-a-token",
            },
          }),
        }),
      },
    } as {
      fetch: typeof fetch;
      XMLHttpRequest: new () => FakeXhr;
      document: { getElementById: () => { textContent: string } };
      __oracleChatGptBackendCapture?: {
        hits: Array<{ text?: string; affinityMatched?: boolean }>;
        requests: { started: number; pending: number; completed: number };
      };
    };
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    const install = new Function(
      "window",
      "location",
      "sessionStorage",
      "document",
      "crypto",
      "TextEncoder",
      "globalThis",
      "URL",
      buildScopedBackendCaptureHook(targetApiUrl, {
        targetUrl,
        accountDigest: digest(userId),
        workspaceDigest: digest(workspaceId),
      }),
    ) as (...args: unknown[]) => void;
    install(
      page,
      { href: targetUrl },
      storage,
      page.document,
      globalThis.crypto,
      TextEncoder,
      { crypto: globalThis.crypto },
      URL,
    );

    const xhr = new page.XMLHttpRequest();
    xhr.open("GET", "https://chatgpt.com/backend-api/conversation/other");
    xhr.setRequestHeader("Authorization", "Bearer stale-token");
    xhr.setRequestHeader("ChatGPT-Account-Id", "stale-workspace");
    xhr.send();
    xhr.open("GET", targetApiUrl);
    xhr.send();
    await vi.waitFor(() => {
      expect(page.__oracleChatGptBackendCapture?.requests.completed).toBe(1);
    });

    expect(page.__oracleChatGptBackendCapture?.hits).toEqual([
      expect.objectContaining({ text: payload, affinityMatched: true }),
    ]);
  });

  test.each([
    { phase: "request start", identities: ["account-b", "account-a"] },
    { phase: "response completion", identities: ["account-a", "account-b"] },
  ])(
    "does not retain a passive body after an identity mismatch at $phase",
    async ({ identities }) => {
      const targetUrl = "https://chatgpt.com/c/conv-1";
      const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
      const workspaceId = "workspace-a";
      const payload = JSON.stringify({ conversation_id: "conv-1", title: "private" });
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      let identityIndex = 0;
      const pageFetch = vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === "/api/auth/session") {
          const userId = identities[Math.min(identityIndex, identities.length - 1)];
          identityIndex += 1;
          return new Response(
            JSON.stringify({ user: { id: userId }, account: { id: workspaceId } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url === targetApiUrl) {
          return new Response(payload, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      const page = {
        fetch: pageFetch as unknown as typeof fetch,
        XMLHttpRequest: class {},
      } as {
        fetch: typeof fetch;
        XMLHttpRequest: new () => object;
        __oracleChatGptBackendCapture?: {
          hits: Array<{ text?: string; chars?: number; affinityMatched?: boolean }>;
          requests: { started: number; pending: number; completed: number };
        };
      };
      const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
      const runtimeGlobal = { crypto: globalThis.crypto };
      const install = new Function(
        "window",
        "location",
        "sessionStorage",
        "crypto",
        "TextEncoder",
        "globalThis",
        "URL",
        buildScopedBackendCaptureHook(targetApiUrl, {
          targetUrl,
          accountDigest: digest("account-a"),
          workspaceDigest: digest(workspaceId),
        }),
      ) as (...args: unknown[]) => void;
      install(
        page,
        { href: targetUrl },
        storage,
        globalThis.crypto,
        TextEncoder,
        runtimeGlobal,
        URL,
      );

      await page.fetch(targetApiUrl);
      await vi.waitFor(() => {
        expect(page.__oracleChatGptBackendCapture?.requests.completed).toBe(1);
      });

      expect(page.__oracleChatGptBackendCapture?.hits).toEqual([
        expect.objectContaining({ text: "", chars: 0, affinityMatched: false }),
      ]);
      expect(storage.setItem).not.toHaveBeenCalled();
    },
  );
  test("actively fetches only the exact route and verified account workspace", async () => {
    const rootTargetUrl = "https://chatgpt.com/c/conv-1";
    const projectTargetUrl = "https://chatgpt.com/g/project-a/c/conv-1";
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const email = "paul@smartypants.ai";
    const userId = "user-1";
    const workspaceId = "workspace-1";
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const run = async ({
      targetUrl = rootTargetUrl,
      href = targetUrl,
      authUserId = userId,
      authWorkspaceId = workspaceId,
      passiveRequestStarted = 0,
      captureOwner: expectedCaptureOwner,
    }: {
      targetUrl?: string;
      href?: string;
      authUserId?: string;
      authWorkspaceId?: string;
      passiveRequestStarted?: number;
      captureOwner?: string;
    } = {}) => {
      const expression = buildApprovedBackendFetchExpression({
        targetUrl,
        targetApiUrl,
        email,
        accountDigest: digest(userId),
        workspaceDigest: digest(workspaceId),
        captureOwner: expectedCaptureOwner,
      });
      const evaluate = new Function(
        "location",
        "document",
        "fetch",
        "crypto",
        "TextEncoder",
        "URL",
        "globalThis",
        `return ${expression};`,
      ) as (...args: unknown[]) => Promise<{ status: string; code?: string; httpStatus?: number }>;
      const pageFetch = vi.fn(async (input: string) => {
        if (input === "/api/auth/session") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              user: { email, id: authUserId },
              account: { id: authWorkspaceId },
            }),
          };
        }
        if (input === targetApiUrl) return { ok: true, status: 200 };
        throw new Error(`Unexpected request: ${input}`);
      });
      const result = await evaluate(
        { href },
        {
          getElementById: () => ({
            textContent: JSON.stringify({
              session: {
                user: { email, id: userId },
                account: { id: workspaceId },
                accessToken: "page-secret-token",
              },
            }),
          }),
        },
        pageFetch,
        globalThis.crypto,
        TextEncoder,
        URL,
        {
          crypto: globalThis.crypto,
          __oracleChatGptBackendCapture: {
            target: targetApiUrl,
            requests: {
              started: passiveRequestStarted,
              pending: passiveRequestStarted,
              completed: 0,
            },
          },
        },
      );
      return { pageFetch, result };
    };

    for (const route of [
      { targetUrl: rootTargetUrl, href: projectTargetUrl },
      { targetUrl: projectTargetUrl, href: rootTargetUrl },
      {
        targetUrl: projectTargetUrl,
        href: "https://chatgpt.com/g/project-b/c/conv-1",
      },
      { targetUrl: rootTargetUrl, href: `${rootTargetUrl}/extra` },
    ]) {
      const refused = await run(route);
      expect(refused.result).toEqual({ status: "refused", code: "scope-mismatch" });
      expect(refused.pageFetch).not.toHaveBeenCalled();
    }

    const passiveObserved = await run({ passiveRequestStarted: 1 });
    expect(passiveObserved.result).toEqual({
      status: "refused",
      code: "passive-request-observed",
    });
    expect(passiveObserved.pageFetch).not.toHaveBeenCalled();
    const legacyPending = await run({ passiveRequestStarted: 1, captureOwner });
    expect(legacyPending.result).toEqual({
      status: "refused",
      code: "capture-owner-mismatch",
    });
    expect(legacyPending.pageFetch).not.toHaveBeenCalled();

    for (const mismatch of [{ authUserId: "other-user" }, { authWorkspaceId: "other-workspace" }]) {
      const wrongIdentity = await run(mismatch);
      expect(wrongIdentity.result).toEqual({ status: "refused", code: "identity-mismatch" });
      expect(wrongIdentity.pageFetch).toHaveBeenCalledTimes(1);
    }

    const captured = await run();
    expect(captured.result).toEqual({ status: "captured", httpStatus: 200 });
    expect(captured.pageFetch).toHaveBeenNthCalledWith(
      2,
      targetApiUrl,
      expect.objectContaining({
        credentials: "include",
        headers: {
          Authorization: "Bearer page-secret-token",
          "ChatGPT-Account-Id": workspaceId,
        },
      }),
    );
    expect(JSON.stringify(captured.result)).not.toContain("page-secret-token");
    const stableProject = await run({
      targetUrl: "https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdef/c/conv-1",
      href: "https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdef-oracle/c/conv-1",
    });
    expect(stableProject.result).toEqual({ status: "captured", httpStatus: 200 });
    const malformedSuffix = await run({
      targetUrl: "https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdef/c/conv-1",
      href: "https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdefZ/c/conv-1",
    });
    expect(malformedSuffix.result).toEqual({ status: "refused", code: "scope-mismatch" });
  });

  test("treats a passive request observed during active verification as a handoff", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { status: "refused", code: "passive-request-observed" } },
      }),
    };

    await expect(
      requestApprovedBackendCapture({
        Runtime: runtime as never,
        targetUrl: "https://chatgpt.com/c/conv-1",
        targetApiUrl: "https://chatgpt.com/backend-api/conversation/conv-1",
        email: "paul@smartypants.ai",
        accountDigest: "a".repeat(64),
        workspaceDigest: "b".repeat(64),
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(false);
  });

  test("does not actively fetch while an exact passive request is pending", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
      const startedAt = Date.now();
      const fallback = vi.fn(async () => true);
      const result = pollCaptureWithPassiveFallbackForTest(
        async () => {
          const completed = Date.now() - startedAt >= 3_000;
          return {
            hit: completed
              ? {
                  kind: "fetch",
                  url: "https://chatgpt.com/backend-api/conversation/conv-1",
                  status: 200,
                  chars: 2,
                }
              : null,
            requests: {
              started: 1,
              pending: completed ? 0 : 1,
              completed: completed ? 1 : 0,
            },
          };
        },
        "https://chatgpt.com/backend-api/conversation/conv-1",
        5_000,
        2_000,
        fallback,
      );
      await vi.runAllTimersAsync();
      await expect(result).resolves.toMatchObject({ hit: { status: 200, chars: 2 } });
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses the original passive deadline after reload and readiness consume the window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
      const passiveDeadline = Date.now() + 1_000;
      vi.setSystemTime(new Date("2026-08-23T00:00:01.500Z"));
      let fallbackRequested = false;
      const fallback = vi.fn(async () => {
        fallbackRequested = true;
        return true;
      });
      const result = pollCaptureWithPassiveFallbackForTest(
        async () => ({
          hit: fallbackRequested
            ? {
                kind: "fetch",
                url: "https://chatgpt.com/backend-api/conversation/conv-1",
                status: 200,
                chars: 2,
              }
            : null,
          requests: { started: 0, pending: 0, completed: 0 },
        }),
        "https://chatgpt.com/backend-api/conversation/conv-1",
        2_000,
        1_000,
        fallback,
        passiveDeadline,
      );

      await expect(result).resolves.toMatchObject({ hit: { status: 200, chars: 2 } });
      expect(fallback).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("waits when the passive request starts inside the fallback callback", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
      let passiveStartedAt: number | null = null;
      const fallback = vi.fn(async (remainingMs: number) => {
        expect(remainingMs).toBeGreaterThan(0);
        passiveStartedAt = Date.now();
        return true;
      });
      const result = pollCaptureWithPassiveFallbackForTest(
        async () => {
          const completed = passiveStartedAt !== null && Date.now() - passiveStartedAt >= 1_000;
          return {
            hit: completed
              ? {
                  kind: "fetch",
                  url: "https://chatgpt.com/backend-api/conversation/conv-1",
                  status: 200,
                  chars: 2,
                }
              : null,
            requests: {
              started: passiveStartedAt === null ? 0 : 1,
              pending: passiveStartedAt !== null && !completed ? 1 : 0,
              completed: completed ? 1 : 0,
            },
          };
        },
        "https://chatgpt.com/backend-api/conversation/conv-1",
        5_000,
        2_000,
        fallback,
      );
      await vi.runAllTimersAsync();
      await expect(result).resolves.toMatchObject({ hit: { status: 200, chars: 2 } });
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses active fallback after a completed passive request has no approved body", async () => {
    let fallbackRequested = false;
    const fallback = vi.fn(async () => {
      fallbackRequested = true;
      return true;
    });
    const result = pollCaptureWithPassiveFallbackForTest(
      async () => ({
        hit: fallbackRequested
          ? {
              kind: "fetch",
              url: "https://chatgpt.com/backend-api/conversation/conv-1",
              status: 200,
              chars: 2,
            }
          : null,
        requests: { started: 1, pending: 0, completed: 1 },
      }),
      "https://chatgpt.com/backend-api/conversation/conv-1",
      1_000,
      0,
      fallback,
    );

    await expect(result).resolves.toMatchObject({ hit: { status: 200, chars: 2 } });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  test("does not consume active fallback when pending passive handoff completes without a hit", async () => {
    vi.useFakeTimers();
    try {
      let passiveState: "idle" | "pending" | "completed" = "idle";
      let fallbackCalls = 0;
      const fallback = vi.fn(async () => {
        fallbackCalls += 1;
        if (fallbackCalls === 1) {
          passiveState = "pending";
          return false;
        }
        return true;
      });
      const result = pollCaptureWithPassiveFallbackForTest(
        async () => {
          const observedState = passiveState;
          if (observedState === "pending") passiveState = "completed";
          return {
            hit:
              fallbackCalls >= 2 && observedState === "completed"
                ? {
                    kind: "fetch",
                    url: "https://chatgpt.com/backend-api/conversation/conv-1",
                    status: 200,
                    chars: 2,
                  }
                : null,
            requests: {
              started: observedState === "idle" ? 0 : 1,
              pending: observedState === "pending" ? 1 : 0,
              completed: observedState === "completed" ? 1 : 0,
            },
          };
        },
        "https://chatgpt.com/backend-api/conversation/conv-1",
        5_000,
        0,
        fallback,
      );

      await vi.runAllTimersAsync();
      await expect(result).resolves.toMatchObject({ hit: { status: 200, chars: 2 } });
      expect(fallback).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects at the capture deadline when the fallback never settles", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
      const fallback = vi.fn(() => new Promise<boolean>(() => {}));
      const result = pollCaptureWithPassiveFallbackForTest(
        async () => ({
          hit: null,
          requests: { started: 0, pending: 0, completed: 0 },
        }),
        "https://chatgpt.com/backend-api/conversation/conv-1",
        3_000,
        1_000,
        fallback,
      );
      const rejection = expect(result).rejects.toThrow(
        /Timed out waiting for backend conversation capture/,
      );
      await vi.runAllTimersAsync();
      await rejection;
      expect(fallback).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not accept a capture poll result that arrives after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const evaluator = vi.fn(
        () =>
          new Promise<CapturePollResult>((resolve) => {
            setTimeout(
              () =>
                resolve({
                  hit: {
                    kind: "fetch",
                    url: "https://chatgpt.com/backend-api/conversation/conv-1",
                    status: 200,
                    chars: 2,
                  },
                  requests: { started: 1, pending: 0, completed: 1 },
                }),
              1_500,
            );
          }),
      );
      const result = pollCaptureWithPassiveFallbackForTest(
        evaluator,
        "https://chatgpt.com/backend-api/conversation/conv-1",
        1_000,
        500,
        vi.fn(async () => true),
      );
      const rejection = expect(result).rejects.toThrow(
        /Timed out waiting for backend conversation capture/,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(evaluator).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("selects the exact conversation body in page and returns only an opaque summary", async () => {
    let expression = "";
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const invalid = JSON.stringify({ conversation_id: "wrong", title: "unapproved" });
    const approved = JSON.stringify({ conversation_id: "conv-1", title: "approved" });
    const result = await pollCaptureWithPassiveFallbackForTest(
      async (value) => {
        expression = value;
        return new Function("window", `return (${value})`)({
          __oracleChatGptBackendCapture: {
            hits: [
              { kind: "fetch", url: targetApiUrl, status: 200, text: invalid },
              { kind: "fetch", url: targetApiUrl, status: 200, text: approved },
            ],
            requests: { started: 2, pending: 0, completed: 2 },
          },
        }) as CapturePollResult;
      },
      targetApiUrl,
      1_000,
      500,
      vi.fn(async () => true),
    );

    expect(expression).not.toContain("location.href");
    expect(expression).not.toContain("document.title");
    expect(expression).not.toContain("bodyPreview");
    expect(expression).not.toContain("current_node");
    expect(result.hit).toMatchObject({ status: 200, chars: approved.length });
    expect(Object.keys(result.hit ?? {}).sort()).toEqual(
      ["chars", "contentType", "kind", "ok", "status", "url"].sort(),
    );
    expect(JSON.stringify(result)).not.toContain("approved");
    expect(JSON.stringify(result)).not.toContain("unapproved");
  });

  test("shares one absolute capture budget across sequential waits", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
      const deadline = Date.now() + 1_000;
      vi.setSystemTime(new Date("2026-08-23T00:00:00.750Z"));
      expect(remainingCaptureBudgetForTest(deadline)).toBe(250);
      vi.setSystemTime(new Date("2026-08-23T00:00:01.000Z"));
      expect(() => remainingCaptureBudgetForTest(deadline)).toThrow(
        /Timed out waiting for backend conversation capture/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects readiness that settles at the absolute capture deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
      const deadline = Date.now() + 1_000;
      const result = runBeforeCaptureDeadlineForTest(
        deadline,
        () =>
          new Promise<string>((resolve) => {
            setTimeout(() => resolve("late"), 1_000);
          }),
      );
      const rejection = expect(result).rejects.toThrow(
        /Timed out waiting for backend conversation capture/,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds post-poll scope evaluation by the capture deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
      const deadline = Date.now() + 1_000;
      const runtime = {
        evaluate: vi.fn(() => new Promise<never>(() => {})),
      };
      const result = assertChatGptExportMutationAffinityForTest(
        runtime as never,
        undefined,
        "https://chatgpt.com/c/conv-1",
        "export capture",
        undefined,
        deadline,
      );
      const rejection = expect(result).rejects.toThrow(
        /Timed out waiting for backend conversation capture/,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(runtime.evaluate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("retrieves persisted capture text after a transient miss", async () => {
    const payload = '{"conversation_id":"conv-1","title":"persisted"}';
    let attempts = 0;
    const result = await retrieveCapturedTextWithEvaluator(
      async (expression) => {
        expect(expression).toContain(
          'sessionStorage.getItem("__oracleChatGptBackendCapture:" + target)',
        );
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

  test("retrieves the approved body after an earlier exact-URL JSON response", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const approved = JSON.stringify({ conversation_id: "conv-1", title: "approved" });
    const result = await retrieveCapturedTextWithEvaluator(
      async (expression) =>
        new Function("window", "sessionStorage", `return (${expression})`)(
          {
            __oracleChatGptBackendCapture: {
              hits: [
                {
                  url: targetApiUrl,
                  status: 200,
                  text: JSON.stringify({ conversation_id: "wrong" }),
                },
                { url: targetApiUrl, status: 200, text: approved },
              ],
            },
          },
          { getItem: () => null },
        ) as never,
      targetApiUrl,
      approved.length,
      approved.length,
    );

    expect(result).toBe(approved);
  });

  test("validates and selects capture text once for chunked retrieval", async () => {
    const targetApiUrl = "https://chatgpt.com/backend-api/conversation/conv-1";
    const approved = JSON.stringify({ conversation_id: "conv-1", title: "approved" });
    const parse = vi.fn((value: string) => JSON.parse(value));
    const sessionStorage = { getItem: vi.fn(() => null) };
    const page = {
      __oracleChatGptBackendCapture: {
        hits: [{ url: targetApiUrl, status: 200, text: approved }],
      },
    };
    const result = await retrieveCapturedTextWithEvaluator(
      async (expression) =>
        new Function("window", "sessionStorage", "JSON", `return (${expression})`)(
          page,
          sessionStorage,
          { parse },
        ) as never,
      targetApiUrl,
      approved.length,
      1,
    );

    expect(result).toBe(approved);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem).toHaveBeenCalledTimes(1);
  });

  test("bounds capture text retrieval by the shared absolute deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
      const deadline = Date.now() + 1_000;
      const result = retrieveCapturedTextWithEvaluator(
        () => new Promise<never>(() => {}),
        "https://chatgpt.com/backend-api/conversation/conv-1",
        2,
        2,
        deadline,
      );
      const rejection = expect(result).rejects.toThrow(
        /Timed out waiting for backend conversation capture/,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

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

  test("exports the exact stored prompt and assistant branch after later child turns", () => {
    const backend = {
      title: "Branched thread",
      conversation_id: "conv-1",
      current_node: "assistant-child",
      mapping: {
        root: { id: "root", parent: null, children: ["user-parent"], message: null },
        "user-parent": {
          id: "user-parent",
          parent: "root",
          children: ["assistant-parent"],
          message: {
            id: "prompt-message",
            author: { role: "user" },
            content: { content_type: "text", parts: ["Parent question"] },
            metadata: {},
          },
        },
        "assistant-parent": {
          id: "assistant-parent",
          parent: "user-parent",
          children: ["user-child"],
          message: {
            id: "assistant-message",
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["Parent answer"] },
            metadata: {},
          },
        },
        "user-child": {
          id: "user-child",
          parent: "assistant-parent",
          children: ["assistant-child"],
          message: {
            id: "child-prompt-message",
            author: { role: "user" },
            content: { content_type: "text", parts: ["Child question"] },
            metadata: {},
          },
        },
        "assistant-child": {
          id: "assistant-child",
          parent: "user-child",
          children: [],
          message: {
            id: "child-assistant-message",
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["Child answer"] },
            metadata: {},
          },
        },
      },
    };
    const affinity = {
      promptMessageId: "prompt-message",
      assistantMessageId: "assistant-message",
    };

    const payload = backendToPayload(backend, "https://chatgpt.com/c/conv-1", "sha", 123, affinity);

    expect(payload.branch_affinity).toEqual({
      prompt_message_id: "prompt-message",
      assistant_message_id: "assistant-message",
      verified: true,
    });
    expect(payload.stats).toMatchObject({ turn_count: 2, current_path_node_count: 3 });
    expect((payload.turns as Array<{ text: string }>).map((turn) => turn.text)).toEqual([
      "Parent question",
      "Parent answer",
    ]);
    expect(() =>
      backendToPayload(backend, "https://chatgpt.com/c/conv-1", "sha", 123, {
        ...affinity,
        promptMessageId: "child-prompt-message",
      }),
    ).toThrow(/not the unique ancestor/i);
  });
});
