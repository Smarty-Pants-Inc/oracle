import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import { describe, expect, test, vi } from "vitest";
import type {
  BrowserUseRequestParams,
  JsonValue,
  OpenBrowserUseNotification,
} from "open-browser-use-sdk";
import {
  acquireOpenBrowserUseRunLock,
  connectOpenBrowserUseTab,
  createOpenBrowserUseChromeClient,
  isAllowedOpenBrowserUseConsultUrl,
  isAllowedOpenBrowserUseConversationUrl,
  prepareOpenBrowserUseChatGptRoute,
  prepareOpenBrowserUseConversationRoute,
  registerOpenBrowserUseTerminationHooks,
  resolveStoredOpenBrowserUseAffinity,
  verifyOpenBrowserUseBridge,
  waitForOpenBrowserUseConversationUrl,
  type OpenBrowserUseClientLike,
  type OpenBrowserUseConnection,
} from "../../src/browser/openBrowserUse.js";
import type { BrowserLogger } from "../../src/browser/types.js";

class FakeObuClient implements OpenBrowserUseClientLike {
  readonly sessionId: string;
  readonly notifications = new EventEmitter();
  readonly request = vi.fn(
    async (_method: string, _params?: BrowserUseRequestParams): Promise<JsonValue> => ({}),
  );
  readonly getInfo = vi.fn(async (): Promise<JsonValue> => ({ version: "0.1.41" }));
  readonly nameSession = vi.fn(async (): Promise<JsonValue> => ({}));
  readonly tabs: JsonValue[] = [];
  readonly createTab = vi.fn(async (): Promise<JsonValue> => {
    const tab = { id: 7, url: "about:blank" };
    this.tabs.push(tab);
    return tab;
  });
  readonly getTabs = vi.fn(async (): Promise<JsonValue> => this.tabs);
  readonly attach = vi.fn(async (): Promise<JsonValue> => ({}));
  readonly finalizeTabs = vi.fn(async (_keep: JsonValue[]): Promise<JsonValue> => ({}));
  readonly turnEnded = vi.fn(async (): Promise<JsonValue> => ({}));
  readonly connect = vi.fn(async () => this);
  readonly close = vi.fn();

  constructor(sessionId = "oracle-session") {
    this.sessionId = sessionId;
  }

  onNotification(handler: (notification: OpenBrowserUseNotification) => void): () => void {
    this.notifications.on("notification", handler);
    return () => this.notifications.off("notification", handler);
  }

  emit(notification: OpenBrowserUseNotification): void {
    this.notifications.emit("notification", notification);
  }
}
function createFakeClientFactory(clients: FakeObuClient[]) {
  return ({ sessionId }: { sessionId: string }) => {
    const client = new FakeObuClient(sessionId);
    clients.push(client);
    return client;
  };
}

describe("Open Browser Use transport", () => {
  test("scopes CDP calls and notifications to the attached tab and child target", async () => {
    const obu = new FakeObuClient();
    const client = createOpenBrowserUseChromeClient(obu, 7);
    const baseEvent = vi.fn();
    const childEvent = vi.fn();
    client.on?.("Network.responseReceived", baseEvent);
    client.on?.("Network.responseReceived.child-1", childEvent);

    await client.send?.("Runtime.evaluate", { expression: "1+1" }, "child-1");
    expect(obu.request).toHaveBeenCalledWith("executeCdp", {
      target: { tabId: 7, sessionId: "child-1" },
      method: "Runtime.evaluate",
      commandParams: { expression: "1+1" },
    });

    obu.emit({
      method: "onCDPEvent",
      params: {
        source: { tabId: 8, sessionId: "child-1" },
        method: "Network.responseReceived",
        params: { ignored: true },
      },
    });
    obu.emit({
      method: "onCDPEvent",
      params: {
        source: { tabId: 7, sessionId: "child-1" },
        method: "Network.responseReceived",
        params: { requestId: "r1" },
      },
    });
    expect(baseEvent).toHaveBeenCalledOnce();
    expect(childEvent).toHaveBeenCalledOnce();
  });

  test.each(["Network.getCookies", "Network.getAllCookies", "Storage.getCookies"])(
    "blocks cookie extraction through %s",
    async (method) => {
      const obu = new FakeObuClient();
      const client = createOpenBrowserUseChromeClient(obu, 7);

      const send = client.send as unknown as (method: string) => Promise<unknown>;
      await expect(send(method)).rejects.toMatchObject({
        details: { stage: "open-browser-use", code: "cookie-extraction-blocked" },
      });
      expect(obu.request).not.toHaveBeenCalled();
    },
  );

  test("redacts sensitive CDP response and event fields", async () => {
    const obu = new FakeObuClient();
    obu.request.mockResolvedValueOnce({
      headers: { Cookie: "session=secret", Accept: "application/json" },
      headersText: "Set-Cookie: session=secret",
    });
    const client = createOpenBrowserUseChromeClient(obu, 7);
    const response = (await client.send?.("Network.getResponseBody")) as unknown as {
      headers: Record<string, string>;
      headersText: string;
    };
    expect(response).toEqual({
      headers: { Cookie: "[redacted]", Accept: "application/json" },
      headersText: "[redacted]",
    });

    const event = vi.fn();
    client.on?.("Network.requestWillBeSentExtraInfo", event);
    obu.emit({
      method: "onCDPEvent",
      params: {
        source: { tabId: 7 },
        method: "Network.requestWillBeSentExtraInfo",
        params: { headers: { Authorization: "Bearer secret", Referer: "https://chatgpt.com/" } },
      },
    });
    expect(event).toHaveBeenCalledWith(
      {
        headers: { Authorization: "[redacted]", Referer: "https://chatgpt.com/" },
      },
      undefined,
    );
  });

  test("preflights the exact extension version and finalizes its temporary session", async () => {
    const obu = new FakeObuClient();

    await expect(
      verifyOpenBrowserUseBridge({
        socketPath: "/tmp/test.sock",
        clientFactory: () => obu,
      }),
    ).resolves.toEqual({ socketPath: "/tmp/test.sock" });
    expect(obu.getInfo).toHaveBeenCalledOnce();
    expect(obu.finalizeTabs).toHaveBeenCalledWith([]);
    expect(obu.close).toHaveBeenCalledOnce();
  });

  test("rejects an incompatible extension version and still finalizes preflight", async () => {
    const obu = new FakeObuClient();
    obu.getInfo.mockResolvedValue({ version: "0.1.40" });

    await expect(
      verifyOpenBrowserUseBridge({
        socketPath: "/tmp/test.sock",
        clientFactory: () => obu,
      }),
    ).rejects.toMatchObject({
      details: {
        stage: "open-browser-use",
        code: "extension-version-mismatch",
        expectedVersion: "0.1.41",
        actualVersion: "0.1.40",
      },
    });
    expect(obu.finalizeTabs).toHaveBeenCalledWith([]);
    expect(obu.close).toHaveBeenCalledOnce();
  });

  test("rejects an incompatible extension before attaching a task tab", async () => {
    const obu = new FakeObuClient();
    obu.getInfo.mockResolvedValue({ version: "0.1.40" });

    await expect(
      connectOpenBrowserUseTab({
        oracleSessionId: "session-1",
        logger: vi.fn() as BrowserLogger,
        socketPath: "/tmp/test.sock",
        clientFactory: () => obu,
      }),
    ).rejects.toMatchObject({
      details: { stage: "open-browser-use", code: "extension-version-mismatch" },
    });
    expect(obu.createTab).not.toHaveBeenCalled();
    expect(obu.close).toHaveBeenCalledOnce();
  });

  test("finalizes only the requested tab and preserves other tabs in the same session", async () => {
    const obu = new FakeObuClient();
    obu.getTabs.mockResolvedValue([
      { id: 7, url: "https://chatgpt.com/c/current-thread" },
      { id: 8, url: "https://chatgpt.com/c/other-thread" },
    ]);
    const connection = await connectOpenBrowserUseTab({
      obuSessionId: "session-1",
      obuTabId: 7,
      conversationUrl: "https://chatgpt.com/c/current-thread",
      logger: vi.fn() as BrowserLogger,
      socketPath: "/tmp/test.sock",
      clientFactory: () => obu,
    });

    await connection.finalize(false);
    expect(obu.finalizeTabs).toHaveBeenCalledWith([{ tabId: 8, status: "handoff" }]);
    expect(obu.turnEnded).toHaveBeenCalledOnce();
    expect(obu.close).toHaveBeenCalledOnce();
  });

  test("a concurrent keep request dominates task-tab finalization", async () => {
    const obu = new FakeObuClient();
    let resolveTurnEnded: ((value: JsonValue) => void) | undefined;
    obu.getTabs.mockResolvedValue([{ id: 7, url: "https://chatgpt.com/c/current-thread" }]);
    obu.turnEnded.mockImplementationOnce(
      () =>
        new Promise<JsonValue>((resolve) => {
          resolveTurnEnded = resolve;
        }),
    );
    const connection = await connectOpenBrowserUseTab({
      obuSessionId: "session-1",
      obuTabId: 7,
      conversationUrl: "https://chatgpt.com/c/current-thread",
      logger: vi.fn() as BrowserLogger,
      socketPath: "/tmp/test.sock",
      clientFactory: () => obu,
    });

    const closeTab = connection.finalize(false);
    await vi.waitFor(() => expect(obu.turnEnded).toHaveBeenCalledOnce());
    const keepTab = connection.finalize(true);
    resolveTurnEnded?.({});
    await Promise.all([closeTab, keepTab]);

    expect(obu.finalizeTabs).toHaveBeenCalledWith([{ tabId: 7, status: "handoff" }]);
  });
  test("fails closed when termination arrives during task-tab handoff", async () => {
    const obu = new FakeObuClient();
    let resolveFinalize: ((value: JsonValue) => void) | undefined;
    obu.getTabs
      .mockResolvedValueOnce([{ id: 7, url: "https://chatgpt.com/c/current-thread" }])
      .mockResolvedValueOnce([{ id: 7, url: "https://chatgpt.com/c/current-thread" }])
      .mockResolvedValueOnce([]);
    obu.finalizeTabs.mockImplementationOnce(
      () =>
        new Promise<JsonValue>((resolve) => {
          resolveFinalize = resolve;
        }),
    );
    const connection = await connectOpenBrowserUseTab({
      obuSessionId: "session-1",
      obuTabId: 7,
      conversationUrl: "https://chatgpt.com/c/current-thread",
      logger: vi.fn() as BrowserLogger,
      socketPath: "/tmp/test.sock",
      clientFactory: () => obu,
    });

    const finalization = connection.finalize(false);
    await vi.waitFor(() => expect(obu.finalizeTabs).toHaveBeenCalledOnce());
    connection.requestKeepTab?.();
    resolveFinalize?.({});

    await expect(finalization).rejects.toMatchObject({
      details: {
        stage: "open-browser-use",
        code: "late-tab-preservation-race",
        recoveryHandle: {
          transport: "obu",
          sessionId: "session-1",
          tabId: 7,
          conversationUrl: "https://chatgpt.com/c/current-thread",
        },
      },
    });
    expect(obu.finalizeTabs).toHaveBeenCalledWith([]);
    expect(obu.close).toHaveBeenCalledOnce();
  });
  test("fails closed when termination arrives after task-tab handoff completes", async () => {
    const obu = new FakeObuClient("session-1");
    obu.getTabs.mockResolvedValue([{ id: 7, url: "https://chatgpt.com/c/current-thread" }]);
    const connection = await connectOpenBrowserUseTab({
      obuSessionId: "session-1",
      obuTabId: 7,
      conversationUrl: "https://chatgpt.com/c/current-thread",
      logger: vi.fn() as BrowserLogger,
      socketPath: "/tmp/test.sock",
      clientFactory: () => obu,
    });

    await connection.finalize(false);
    connection.requestKeepTab?.();

    await expect(connection.finalize(true)).rejects.toMatchObject({
      details: {
        stage: "open-browser-use",
        code: "late-tab-preservation-race",
        recoveryHandle: {
          transport: "obu",
          sessionId: "session-1",
          tabId: 7,
          conversationUrl: "https://chatgpt.com/c/current-thread",
        },
      },
    });
    expect(obu.finalizeTabs).toHaveBeenCalledOnce();
    expect(obu.close).toHaveBeenCalledOnce();
  });

  test("refuses to finalize from a malformed tab inventory", async () => {
    const obu = new FakeObuClient();
    obu.getTabs
      .mockResolvedValueOnce([{ id: 7, url: "https://chatgpt.com/c/current-thread" }])
      .mockResolvedValue([
        { id: 7, url: "https://chatgpt.com/c/current-thread" },
        { id: "8", url: "https://chatgpt.com/c/other-thread" },
      ] as unknown as JsonValue);
    const connection = await connectOpenBrowserUseTab({
      obuSessionId: "session-1",
      obuTabId: 7,
      conversationUrl: "https://chatgpt.com/c/current-thread",
      logger: vi.fn() as BrowserLogger,
      socketPath: "/tmp/test.sock",
      clientFactory: () => obu,
    });

    await expect(connection.finalize(false)).rejects.toMatchObject({
      details: { stage: "open-browser-use", code: "tab-finalize-failed" },
    });
    expect(obu.finalizeTabs).not.toHaveBeenCalled();
  });

  test("retries a transient task-tab finalization failure once", async () => {
    const obu = new FakeObuClient("session-1");
    obu.getTabs.mockResolvedValue([{ id: 7, url: "https://chatgpt.com/c/current-thread" }]);
    obu.finalizeTabs.mockRejectedValueOnce(new Error("transient finalize failure"));
    const connection = await connectOpenBrowserUseTab({
      obuSessionId: "session-1",
      obuTabId: 7,
      conversationUrl: "https://chatgpt.com/c/current-thread",
      logger: vi.fn() as BrowserLogger,
      socketPath: "/tmp/test.sock",
      clientFactory: () => obu,
    });

    await expect(connection.finalize(false)).resolves.toBeUndefined();
    expect(obu.finalizeTabs).toHaveBeenCalledTimes(2);
    expect(obu.close).toHaveBeenCalledOnce();
  });

  test("surfaces task-tab finalization failures with an exact recovery handle", async () => {
    const obu = new FakeObuClient("session-1");
    obu.getTabs.mockResolvedValue([{ id: 7, url: "https://chatgpt.com/c/current-thread" }]);
    obu.finalizeTabs.mockRejectedValue(new Error("finalize failed"));
    const connection = await connectOpenBrowserUseTab({
      obuSessionId: "session-1",
      obuTabId: 7,
      conversationUrl: "https://chatgpt.com/c/current-thread",
      logger: vi.fn() as BrowserLogger,
      socketPath: "/tmp/test.sock",
      clientFactory: () => obu,
    });

    await expect(connection.finalize(false)).rejects.toMatchObject({
      message: "Failed to finalize the task-owned main-Chrome Oracle tab.",
      details: {
        stage: "open-browser-use",
        code: "tab-finalize-failed",
        recoveryHandle: {
          transport: "obu",
          sessionId: "session-1",
          tabId: 7,
          conversationUrl: "https://chatgpt.com/c/current-thread",
        },
      },
    });
    expect(obu.finalizeTabs).toHaveBeenCalledTimes(2);
    expect(obu.close).toHaveBeenCalledOnce();
  });

  test("uses one native-host lock regardless of ORACLE_HOME_DIR", async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-obu-lock-"));
    const socketPath = path.join(runtimeDir, "native-host.sock");
    const registryPath = path.join(runtimeDir, "active.json");
    const server = createServer();
    const originalOracleHome = process.env.ORACLE_HOME_DIR;
    try {
      await chmod(runtimeDir, 0o700);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o600);
      await writeFile(registryPath, JSON.stringify({ pid: process.pid, socketPath }), {
        mode: 0o600,
      });
      const logger = vi.fn() as BrowserLogger;

      process.env.ORACLE_HOME_DIR = path.join(runtimeDir, "oracle-home-a");
      const first = await acquireOpenBrowserUseRunLock({
        timeoutMs: 500,
        logger,
        registryPath,
      });
      await first.release();

      process.env.ORACLE_HOME_DIR = path.join(runtimeDir, "oracle-home-b");
      const second = await acquireOpenBrowserUseRunLock({
        timeoutMs: 500,
        logger,
        registryPath,
      });
      expect(second.path).toBe(first.path);
      expect(path.dirname(second.path)).toBe(path.join(runtimeDir, "oracle-main-chrome"));
      await second.release();
    } finally {
      if (originalOracleHome === undefined) delete process.env.ORACLE_HOME_DIR;
      else process.env.ORACLE_HOME_DIR = originalOracleHome;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(runtimeDir, { recursive: true, force: true });
    }
  });
  test("accepts a pid-zero registry when its private socket is reachable", async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-obu-pid-zero-"));
    const socketPath = path.join(runtimeDir, "native-host.sock");
    const registryPath = path.join(runtimeDir, "active.json");
    const server = createServer((socket) => socket.destroy());
    try {
      await chmod(runtimeDir, 0o700);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o600);
      await writeFile(registryPath, JSON.stringify({ pid: 0, socketPath }), { mode: 0o600 });

      const lock = await acquireOpenBrowserUseRunLock({
        timeoutMs: 500,
        logger: vi.fn() as BrowserLogger,
        registryPath,
      });
      expect(lock.path).toBe(path.join(runtimeDir, "oracle-main-chrome", "oracle-automation.lock"));
      await lock.release();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(runtimeDir, { recursive: true, force: true });
    }
  });

  test("recovers a missing stored tab in a fresh OBU session", async () => {
    const clients: FakeObuClient[] = [];
    const connection = await connectOpenBrowserUseTab({
      oracleSessionId: "session-1",
      obuSessionId: "stored-session",
      obuTabId: 7,
      conversationUrl: "https://chatgpt.com/c/current-thread",
      logger: vi.fn() as BrowserLogger,
      socketPath: "/tmp/test.sock",
      clientFactory: createFakeClientFactory(clients),
    });

    expect(clients).toHaveLength(2);
    expect(clients[0]?.sessionId).toBe("stored-session");
    expect(connection.sessionId).not.toBe("stored-session");
    expect(connection.tabId).toBe(7);
    expect(clients[0]?.finalizeTabs).not.toHaveBeenCalled();
    await connection.finalize(true);
    expect(clients[1]?.finalizeTabs).toHaveBeenCalledWith([{ tabId: 7, status: "handoff" }]);
  });

  test("rejects a stored tab that points at another conversation", async () => {
    const obu = new FakeObuClient();
    obu.getTabs.mockResolvedValue([
      { id: 7, url: "https://chatgpt.com/c/other-thread", title: "other" },
    ]);
    await expect(
      connectOpenBrowserUseTab({
        obuSessionId: "stored-session",
        obuTabId: 7,
        conversationUrl: "https://chatgpt.com/c/expected-thread",
        logger: vi.fn() as BrowserLogger,
        socketPath: "/tmp/test.sock",
        clientFactory: () => obu,
      }),
    ).rejects.toThrow(/no longer points to the expected ChatGPT conversation/i);
    expect(obu.finalizeTabs).not.toHaveBeenCalled();
  });
  test.each([
    ["https://chatgpt.com/c/shared-thread", "https://chatgpt.com/g/project-a/c/shared-thread"],
    [
      "https://chatgpt.com/g/project-a/c/shared-thread",
      "https://chatgpt.com/g/project-b/c/shared-thread",
    ],
  ])("rejects a tab whose project scope changes (%s -> %s)", async (expectedUrl, actualUrl) => {
    const obu = new FakeObuClient();
    obu.getTabs.mockResolvedValue([{ id: 7, url: actualUrl }]);
    await expect(
      connectOpenBrowserUseTab({
        obuSessionId: "stored-session",
        obuTabId: 7,
        conversationUrl: expectedUrl,
        logger: vi.fn() as BrowserLogger,
        socketPath: "/tmp/test.sock",
        clientFactory: () => obu,
      }),
    ).rejects.toMatchObject({
      details: { stage: "open-browser-use", code: "tab-affinity-mismatch" },
    });
    expect(obu.finalizeTabs).not.toHaveBeenCalled();
  });

  test("returns an exact recovery handle when created-tab cleanup fails", async () => {
    const obu = new FakeObuClient("oracle-session-1");
    obu.attach.mockRejectedValueOnce(new Error("attach failed"));
    obu.finalizeTabs.mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(
      connectOpenBrowserUseTab({
        oracleSessionId: "session-1",
        conversationUrl: "https://chatgpt.com/c/expected-thread",
        logger: vi.fn() as BrowserLogger,
        socketPath: "/tmp/test.sock",
        clientFactory: () => obu,
      }),
    ).rejects.toMatchObject({
      message: "attach failed",
      details: {
        stage: "open-browser-use",
        recoveryHandle: {
          transport: "obu",
          sessionId: "oracle-session-1",
          tabId: 7,
          conversationUrl: "https://chatgpt.com/c/expected-thread",
        },
      },
    });
    expect(obu.close).toHaveBeenCalledOnce();
  });

  test.each([
    "https://chatgpt.com/",
    "https://chatgpt.com/?temporary-chat=true",
    "https://chatgpt.com/g/g-p-test/project",
  ])("allows safe new-consult URL %s", (targetUrl) => {
    expect(isAllowedOpenBrowserUseConsultUrl(targetUrl)).toBe(true);
  });

  test.each([
    "https://chatgpt.com/settings",
    "https://chatgpt.com/backend-api/me",
    "https://chatgpt.com/c/thread-1",
    "https://chatgpt.com/g/g-p-test/project/extra",
    "https://chatgpt.com/g/g-p-test/project?temporary-chat=true",
  ])("rejects non-consult URL %s", (targetUrl) => {
    expect(isAllowedOpenBrowserUseConsultUrl(targetUrl)).toBe(false);
  });

  test.each(["https://chatgpt.com/c/thread-1", "https://chatgpt.com/g/g-p-test/c/thread-1"])(
    "allows exact stored conversation URL %s",
    (targetUrl) => {
      expect(isAllowedOpenBrowserUseConversationUrl(targetUrl)).toBe(true);
    },
  );

  test.each([
    "https://chatgpt.com/c/thread-1?temporary-chat=true",
    "https://chatgpt.com/c/thread-1#fragment",
    "https://chatgpt.com/g/g-p-test/project/c/thread-1",
    "https://chatgpt.com/%63/thread-1",
    "https://example.com/c/thread-1",
  ])("rejects unsafe stored conversation URL %s", (targetUrl) => {
    expect(isAllowedOpenBrowserUseConversationUrl(targetUrl)).toBe(false);
  });

  test.each([{ created: false }, { created: true }])(
    "routes a stored conversation safely when created=$created",
    async (scenario) => {
      let currentUrl = scenario.created ? "about:blank" : "https://chatgpt.com/c/thread-1";
      const navigate = vi.fn(async ({ url }: { url: string }) => {
        currentUrl = url;
      });
      const accountDigest = "a".repeat(64);
      const workspaceDigest = "b".repeat(64);
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "document.readyState") return { result: { value: "complete" } };
        if (expression.includes('const kind = "workspace"')) {
          return { result: { value: { status: "selected" } } };
        }
        if (expression.includes("/api/auth/session")) {
          return {
            result: {
              value: {
                status: "authenticated",
                email: "paul@smartypants.ai",
                accountDigest,
                workspaceDigest,
              },
            },
          };
        }
        if (expression.includes('typeof location === "object"')) {
          return { result: { value: currentUrl } };
        }
        if (expression.includes("cf-chl")) return { result: { value: { shell: true } } };
        return { result: { value: false } };
      });
      const connection = {
        client: { Page: { navigate }, Runtime: { evaluate } },
        created: scenario.created,
      } as unknown as OpenBrowserUseConnection;

      await expect(
        prepareOpenBrowserUseConversationRoute({
          connection,
          expectation: {
            email: "paul@smartypants.ai",
            workspaceName: "Paul Bettner",
            accountDigest,
            workspaceDigest,
          },
          targetUrl: "https://chatgpt.com/c/thread-1",
          logger: vi.fn() as BrowserLogger,
        }),
      ).resolves.toMatchObject({ accountDigest, workspaceDigest });
      expect(navigate.mock.calls.map(([call]) => call.url)).toEqual([
        "https://chatgpt.com/",
        "https://chatgpt.com/c/thread-1",
      ]);
    },
  );

  test("waits for the exact task tab to expose a stable conversation URL", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi
        .fn()
        .mockResolvedValueOnce({ result: { value: "https://chatgpt.com/" } })
        .mockResolvedValueOnce({ result: { value: "https://chatgpt.com/c/thread-1" } });
      const connection = {
        client: { Runtime: { evaluate } },
      } as unknown as OpenBrowserUseConnection;

      const result = waitForOpenBrowserUseConversationUrl({ connection, timeoutMs: 1_000 });
      await vi.runAllTimersAsync();
      await expect(result).resolves.toBe("https://chatgpt.com/c/thread-1");
      expect(evaluate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  test("cleans the capture hook before preserving the exact task tab on termination", async () => {
    const previousExitCode = process.exitCode;
    const events: string[] = [];
    let resolveReleased: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const beforeFinalize = vi.fn(async () => {
      events.push("cleanup");
    });
    const finalize = vi.fn(async (_keepTab: boolean) => {
      events.push("finalize");
    });
    const releaseLock = vi.fn(async () => {
      events.push("release");
      resolveReleased?.();
    });
    const removeHooks = registerOpenBrowserUseTerminationHooks({
      connection: () => ({ finalize }),
      beforeFinalize,
      releaseLock,
      logger: vi.fn() as BrowserLogger,
    });
    try {
      process.emit("SIGINT");
      await released;
      await Promise.resolve();
      await Promise.resolve();
      expect(beforeFinalize).toHaveBeenCalledOnce();
      expect(finalize).toHaveBeenCalledWith(true);
      expect(releaseLock).toHaveBeenCalledOnce();
      expect(events).toEqual(["cleanup", "finalize", "release"]);
      expect(process.exitCode).toBe(130);
    } finally {
      removeHooks();
      process.exitCode = previousExitCode;
    }
  });

  test("waits for an in-flight task-tab connection before termination handoff", async () => {
    const previousExitCode = process.exitCode;
    let resolveConnection:
      | ((connection: Pick<OpenBrowserUseConnection, "finalize">) => void)
      | undefined;
    const connectionReady = new Promise<Pick<OpenBrowserUseConnection, "finalize">>((resolve) => {
      resolveConnection = resolve;
    });
    const getConnection = vi.fn(() => connectionReady);
    let resolveReleased: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const finalize = vi.fn(async (_keepTab: boolean) => {});
    const releaseLock = vi.fn(async () => resolveReleased?.());
    const removeHooks = registerOpenBrowserUseTerminationHooks({
      connection: getConnection,
      releaseLock,
      logger: vi.fn() as BrowserLogger,
    });
    try {
      process.emit("SIGTERM");
      await Promise.resolve();
      expect(releaseLock).not.toHaveBeenCalled();
      resolveConnection?.({ finalize });
      await released;
      expect(getConnection).toHaveBeenCalledOnce();
      expect(finalize).toHaveBeenCalledWith(true);
      expect(releaseLock).toHaveBeenCalledOnce();
    } finally {
      removeHooks();
      process.exitCode = previousExitCode;
    }
  });
  test("marks the routing lock uncertain when signal-time release fails", async () => {
    const previousExitCode = process.exitCode;
    const finalize = vi.fn(async (_keepTab: boolean) => undefined);
    const releaseLock = vi.fn(async () => {
      throw new Error("release failed");
    });
    const markLockUncertain = vi.fn(async () => undefined);
    const removeHooks = registerOpenBrowserUseTerminationHooks({
      connection: () => ({
        finalize,
        sessionId: "session-1",
        tabId: 7,
        tabUrl: "https://chatgpt.com/c/thread-1",
      }),
      releaseLock,
      markLockUncertain,
      logger: vi.fn() as BrowserLogger,
    });
    try {
      process.emit("SIGTERM");
      await removeHooks.waitForDrain();
      expect(finalize).toHaveBeenCalledWith(true);
      expect(releaseLock).toHaveBeenCalledOnce();
      expect(markLockUncertain).toHaveBeenCalledWith({
        reason: expect.stringContaining("lock release failed"),
        recoveryHandle: {
          transport: "obu",
          sessionId: "session-1",
          tabId: 7,
          conversationUrl: "https://chatgpt.com/c/thread-1",
        },
      });
      expect(removeHooks.isLockUncertain()).toBe(true);
    } finally {
      removeHooks();
      process.exitCode = previousExitCode;
    }
  });
  test("retains the routing lock when task-tab finalization times out", async () => {
    vi.useFakeTimers();
    const previousExitCode = process.exitCode;
    let resolveFinalize: (() => void) | undefined;
    const finalize = vi.fn(
      (_keepTab: boolean) =>
        new Promise<void>((resolve) => {
          resolveFinalize = resolve;
        }),
    );
    const releaseLock = vi.fn(async () => undefined);
    const markLockUncertain = vi.fn(async () => undefined);
    const logger = vi.fn() as BrowserLogger;
    const removeHooks = registerOpenBrowserUseTerminationHooks({
      connection: () => ({ finalize }),
      releaseLock,
      markLockUncertain,
      logger,
      drainTimeoutMs: 50,
    });
    try {
      process.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(100);
      await removeHooks.waitForDrain();
      expect(finalize).toHaveBeenCalledWith(true);
      expect(releaseLock).not.toHaveBeenCalled();
      expect(markLockUncertain).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.stringContaining("finalization") }),
      );
      expect(removeHooks.isLockUncertain()).toBe(true);
      resolveFinalize?.();
    } finally {
      removeHooks();
      process.exitCode = previousExitCode;
      vi.useRealTimers();
    }
  });
  test("retains the routing lock when the native host never resolves a task tab", async () => {
    vi.useFakeTimers();
    const previousExitCode = process.exitCode;
    const connection = new Promise<Pick<OpenBrowserUseConnection, "finalize">>(() => {});
    const releaseLock = vi.fn(async () => undefined);
    const markLockUncertain = vi.fn(async () => undefined);
    const logger = vi.fn() as BrowserLogger;
    const removeHooks = registerOpenBrowserUseTerminationHooks({
      connection: () => connection,
      releaseLock,
      markLockUncertain,
      logger,
      drainTimeoutMs: 50,
    });
    try {
      process.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(100);
      await removeHooks.waitForDrain();
      expect(releaseLock).not.toHaveBeenCalled();
      expect(markLockUncertain).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.stringContaining("connection") }),
      );
      expect(removeHooks.isLockUncertain()).toBe(true);
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining("Open Browser Use SIGTERM connection resolution timed out"),
      );
      expect(process.exitCode).toBe(1);
    } finally {
      removeHooks();
      process.exitCode = previousExitCode;
      vi.useRealTimers();
    }
  });
  test("persists a recovery handle when task-tab connection fails", async () => {
    const previousExitCode = process.exitCode;
    const releaseLock = vi.fn(async () => undefined);
    const markLockUncertain = vi.fn(async () => undefined);
    const recoveryHandle = {
      transport: "obu",
      sessionId: "session-1",
      tabId: 7,
      conversationUrl: "https://chatgpt.com/c/thread-1",
    };
    const connectionError = new BrowserAutomationError("connection failed", {
      stage: "open-browser-use",
      code: "tab-connection-failed",
      recoveryHandle,
    });
    const removeHooks = registerOpenBrowserUseTerminationHooks({
      connection: () => Promise.reject(connectionError),
      releaseLock,
      markLockUncertain,
      logger: vi.fn() as BrowserLogger,
    });
    try {
      process.emit("SIGTERM");
      await removeHooks.waitForDrain();
      expect(releaseLock).not.toHaveBeenCalled();
      expect(markLockUncertain).toHaveBeenCalledWith(expect.objectContaining({ recoveryHandle }));
    } finally {
      removeHooks();
      process.exitCode = previousExitCode;
    }
  });

  test("persists the exact recovery handle when a timed-out connection resolves late", async () => {
    vi.useFakeTimers();
    const previousExitCode = process.exitCode;
    let resolveConnection:
      | ((
          connection: Pick<
            OpenBrowserUseConnection,
            "finalize" | "requestKeepTab" | "sessionId" | "tabId" | "tabUrl"
          >,
        ) => void)
      | undefined;
    const connection = new Promise<
      Pick<
        OpenBrowserUseConnection,
        "finalize" | "requestKeepTab" | "sessionId" | "tabId" | "tabUrl"
      >
    >((resolve) => {
      resolveConnection = resolve;
    });
    const finalize = vi.fn(async (_keepTab: boolean) => undefined);
    const requestKeepTab = vi.fn();
    const releaseLock = vi.fn(async () => undefined);
    const markLockUncertain = vi.fn(async () => undefined);
    const removeHooks = registerOpenBrowserUseTerminationHooks({
      connection: () => connection,
      releaseLock,
      markLockUncertain,
      logger: vi.fn() as BrowserLogger,
      drainTimeoutMs: 50,
    });
    try {
      process.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(100);
      await removeHooks.waitForDrain();
      expect(markLockUncertain).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.stringContaining("connection resolution") }),
      );
      resolveConnection?.({
        finalize,
        requestKeepTab,
        sessionId: "session-late",
        tabId: 9,
        tabUrl: "https://chatgpt.com/g/project/c/thread-1",
      });
      await vi.runAllTimersAsync();
      await vi.waitFor(() =>
        expect(markLockUncertain).toHaveBeenCalledWith(
          expect.objectContaining({
            recoveryHandle: {
              transport: "obu",
              sessionId: "session-late",
              tabId: 9,
              conversationUrl: "https://chatgpt.com/g/project/c/thread-1",
            },
          }),
        ),
      );
      expect(requestKeepTab).toHaveBeenCalledOnce();
      expect(finalize).toHaveBeenCalledWith(true);
      expect(releaseLock).not.toHaveBeenCalled();
    } finally {
      removeHooks();
      process.exitCode = previousExitCode;
      vi.useRealTimers();
    }
  });

  test.each([
    "https://chatgpt.com:444/c/thread-1",
    "https://chatgpt.com/%63/thread-1",
    "https://chatgpt.com/settings",
  ])("rejects ambiguous main-Chrome target URL %s", async (targetUrl) => {
    await expect(
      prepareOpenBrowserUseChatGptRoute({
        connection: {} as OpenBrowserUseConnection,
        expectation: { email: "paul@smartypants.ai", workspaceName: "Paul Bettner" },
        targetUrl,
        logger: vi.fn() as BrowserLogger,
      }),
    ).rejects.toMatchObject({
      details: { stage: "open-browser-use", code: "chatgpt-origin-mismatch" },
    });
  });

  test("resolves one complete affinity and rejects duplicated conflicts", () => {
    const digest = "a".repeat(64);
    const workspaceDigest = "b".repeat(64);
    const runtime = {
      browserTransport: "obu" as const,
      obuSessionId: "oracle-session",
      obuTabId: 7,
      chatGptAccountEmail: "paul@smartypants.ai",
      chatGptWorkspaceName: "Paul Bettner",
      chatGptAccountDigest: digest,
      chatGptWorkspaceDigest: workspaceDigest,
    };
    expect(
      resolveStoredOpenBrowserUseAffinity({
        runtime,
        configs: [{ ...runtime }],
        conversationUrl: "https://chatgpt.com/c/thread-1",
      }),
    ).toMatchObject({
      sessionId: "oracle-session",
      tabId: 7,
      email: "paul@smartypants.ai",
      workspaceName: "Paul Bettner",
      accountDigest: digest,
      workspaceDigest,
    });
    expect(() =>
      resolveStoredOpenBrowserUseAffinity({
        runtime,
        configs: [{ ...runtime, obuTabId: 8 }],
        conversationUrl: "https://chatgpt.com/c/thread-1",
      }),
    ).toThrow(/tab identity is conflicting/i);
  });

  test("rejects conflicting stored conversation evidence", () => {
    const digest = "a".repeat(64);
    const workspaceDigest = "b".repeat(64);
    const runtime = {
      browserTransport: "obu" as const,
      obuSessionId: "oracle-session",
      obuTabId: 7,
      chatGptAccountEmail: "paul@smartypants.ai",
      chatGptWorkspaceName: "Paul Bettner",
      chatGptAccountDigest: digest,
      chatGptWorkspaceDigest: workspaceDigest,
      tabUrl: "https://chatgpt.com/c/thread-1",
      conversationId: "thread-1",
    };
    expect(() =>
      resolveStoredOpenBrowserUseAffinity({
        runtime,
        configs: [{ ...runtime }],
        conversationUrl: "https://chatgpt.com/c/thread-1",
        conversationUrls: ["https://chatgpt.com/c/thread-2"],
      }),
    ).toThrow(/conversation affinity is conflicting/i);
  });
  test("rejects root/project scope conflicts with the same conversation id", () => {
    const digest = "a".repeat(64);
    const workspaceDigest = "b".repeat(64);
    const runtime = {
      browserTransport: "obu" as const,
      obuSessionId: "oracle-session",
      obuTabId: 7,
      chatGptAccountEmail: "paul@smartypants.ai",
      chatGptWorkspaceName: "Paul Bettner",
      chatGptAccountDigest: digest,
      chatGptWorkspaceDigest: workspaceDigest,
      tabUrl: "https://chatgpt.com/g/project-a/c/thread-1",
      conversationId: "thread-1",
    };
    expect(() =>
      resolveStoredOpenBrowserUseAffinity({
        runtime,
        configs: [{ ...runtime }],
        conversationUrl: "https://chatgpt.com/c/thread-1",
      }),
    ).toThrow(/conversation affinity is conflicting/i);
  });
});
