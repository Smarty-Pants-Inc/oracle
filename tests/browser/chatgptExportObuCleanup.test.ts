import { afterEach, describe, expect, test as it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { captureApprovedChatGptConversationBackendViaObu } from "../../src/browser/chatgptExport.js";

const test = process.platform === "win32" ? it.skip : it;

type ObuResult = { stdout: string; stderr: string };
type MockChild = { killed: boolean; kill: ReturnType<typeof vi.fn> };

function response(result: unknown): ObuResult {
  return { stdout: JSON.stringify({ result }), stderr: "" };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function methodAndParams(args: string[]): {
  method: string;
  params: { expression?: string; identifier?: string };
} {
  const method = args[args.indexOf("--method") + 1] ?? "unknown";
  const params = JSON.parse(args[args.indexOf("--params") + 1] ?? "{}") as {
    expression?: string;
    identifier?: string;
  };
  return { method, params };
}

function mockObuExec(handler: (args: string[]) => ObuResult | Promise<ObuResult>): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      let child: MockChild;
      child = {
        killed: false,
        kill: vi.fn(() => {
          child.killed = true;
          return true;
        }),
      };
      Promise.resolve()
        .then(() => handler(args))
        .then(
          ({ stdout, stderr }) => callback(null, stdout, stderr),
          (error: unknown) =>
            callback(error instanceof Error ? error : new Error(String(error)), "", ""),
        );
      return child;
    },
  );
}

function mockPrelude(
  accountDigest: string,
  extra: (
    method: string,
    params: { expression?: string; identifier?: string },
  ) => ObuResult | Promise<ObuResult>,
): void {
  mockObuExec((args) => {
    const { method, params } = methodAndParams(args);
    if (method === "Runtime.evaluate") {
      if (params.expression === "location.href") {
        return response({ result: { value: "https://chatgpt.com/c/conv-1" } });
      }
      if (params.expression?.includes("/api/auth/session")) {
        return response({ result: { value: accountDigest } });
      }
      if (params.expression?.includes("sessionStorage.removeItem")) {
        return response({ result: { value: true } });
      }
    }
    return extra(method, params);
  });
}

afterEach(() => {
  execFileMock.mockReset();
  vi.useRealTimers();
});

describe("OBU ChatGPT export cleanup", () => {
  test("sanitizes child-process failures and still cleans registered capture state", async () => {
    const events: string[] = [];
    mockPrelude("a".repeat(64), (method) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        events.push("register-hook");
        return response({ identifier: "capture-hook" });
      }
      if (method === "Page.enable") {
        events.push("enable-after-external-reload");
        throw new Error("sensitive Page.enable URL https://private.example/token");
      }
      if (method === "Page.removeScriptToEvaluateOnNewDocument") {
        events.push("remove-script");
        return response({});
      }
      throw new Error(`Unexpected OBU CDP method: ${method}`);
    });

    const error = await captureApprovedChatGptConversationBackendViaObu({
      targetUrl: "https://chatgpt.com/c/conv-1",
      outDir: "/tmp/oracle-obu-cleanup-race-test",
      sessionId: "test-session",
      tabId: "test-tab",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/obu cdp Page\.enable process failed/i);
    expect((error as Error).message).not.toContain("private.example");
    expect(events).toEqual(["register-hook", "enable-after-external-reload", "remove-script"]);
  });

  test("removes an OBU hook that registers after the export deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const installedHooks = new Set<string>();
    const removedHooks: string[] = [];
    const registrationStarted = deferred<void>();
    const registration = deferred<ObuResult>();

    mockPrelude("a".repeat(64), (method, params) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        registrationStarted.resolve();
        return registration.promise;
      }
      if (method === "Page.removeScriptToEvaluateOnNewDocument") {
        if (!params.identifier) throw new Error("Late hook removal was missing its identifier.");
        removedHooks.push(params.identifier);
        installedHooks.delete(params.identifier);
        return response({});
      }
      throw new Error(`Unexpected OBU CDP method: ${method}`);
    });

    const capture = captureApprovedChatGptConversationBackendViaObu({
      targetUrl: "https://chatgpt.com/c/conv-1",
      outDir: "/tmp/oracle-obu-late-registration-test",
      sessionId: "test-session",
      tabId: "test-tab",
      timeoutMs: 10,
    });
    const failure = capture.catch((error: unknown) => error);

    await registrationStarted.promise;
    await vi.advanceTimersByTimeAsync(1_010);
    const error = await failure;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toMatch(/registration and cleanup failed/i);

    installedHooks.add("late-hook");
    registration.resolve(response({ identifier: "late-hook" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(removedHooks).toEqual(["late-hook"]);
    expect([...installedHooks]).toEqual([]);
  });

  test("reports a failed removal for an OBU hook that registers after the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const removalError = new Error("late OBU hook removal failed");
    const registrationStarted = deferred<void>();
    const registration = deferred<ObuResult>();

    mockPrelude("a".repeat(64), (method) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        registrationStarted.resolve();
        return registration.promise;
      }
      if (method === "Page.removeScriptToEvaluateOnNewDocument") {
        return Promise.reject(removalError);
      }
      throw new Error(`Unexpected OBU CDP method: ${method}`);
    });

    const capture = captureApprovedChatGptConversationBackendViaObu({
      targetUrl: "https://chatgpt.com/c/conv-1",
      outDir: "/tmp/oracle-obu-late-registration-failure-test",
      sessionId: "test-session",
      tabId: "test-tab",
      timeoutMs: 10,
    });
    const failure = capture.catch((error: unknown) => error);

    await registrationStarted.promise;
    await vi.advanceTimersByTimeAsync(10);
    registration.resolve(response({ identifier: "late-hook" }));
    const error = await failure;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toMatch(/registration and cleanup failed/i);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringMatching(/process failed/i) }),
      ]),
    );
  });

  test("does not expose OBU stdout, stderr, or envelope details", async () => {
    mockObuExec(async () => ({
      stdout: "not-json https://private.example/conversation?token=secret",
      stderr: "Bearer super-secret-token",
    }));

    const error = await captureApprovedChatGptConversationBackendViaObu({
      targetUrl: "https://chatgpt.com/c/conv-1",
      outDir: "/tmp/oracle-obu-secret-output-test",
      sessionId: "test-session",
      tabId: "test-tab",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/invalid response/i);
    expect((error as Error).message).not.toContain("private.example");
    expect((error as Error).message).not.toContain("super-secret-token");
  });

  test("kills a stalled OBU child at the operation deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const stalled = deferred<ObuResult>();
    mockObuExec(() => stalled.promise);

    const capture = captureApprovedChatGptConversationBackendViaObu({
      targetUrl: "https://chatgpt.com/c/conv-1",
      outDir: "/tmp/oracle-obu-timeout-test",
      sessionId: "test-session",
      tabId: "test-tab",
      timeoutMs: 10,
    });
    const failure = capture.catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(10);
    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/timed out waiting for obu cdp/i);
    const child = execFileMock.mock.results[0]?.value as MockChild | undefined;
    expect(child?.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child?.kill).toHaveBeenCalledWith("SIGKILL");
    const spawnOptions = execFileMock.mock.calls[0]?.[2] as { detached?: boolean } | undefined;
    expect(spawnOptions?.detached).toBe(process.platform !== "win32");
  });

  test("waits for detached OBU termination grace before escalating", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const child = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
        return child;
      }),
      removeListener: vi.fn((event: string) => {
        listeners.delete(event);
        return child;
      }),
    };
    const killProcess = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        _callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => child,
    );

    try {
      const failure = captureApprovedChatGptConversationBackendViaObu({
        targetUrl: "https://chatgpt.com/c/conv-1",
        outDir: "/tmp/oracle-obu-term-grace-test",
        sessionId: "test-session",
        tabId: "test-tab",
        timeoutMs: 10,
      }).catch((caught: unknown) => caught);

      await vi.advanceTimersByTimeAsync(10);
      await expect(failure).resolves.toMatchObject({
        message: "Timed out waiting for obu cdp Runtime.evaluate.",
      });
      expect(killProcess).toHaveBeenCalledWith(-12345, "SIGTERM");
      expect(killProcess).not.toHaveBeenCalledWith(-12345, "SIGKILL");

      await vi.advanceTimersByTimeAsync(99);
      expect(killProcess).not.toHaveBeenCalledWith(-12345, "SIGKILL");
      await vi.advanceTimersByTimeAsync(1);
      expect(killProcess).toHaveBeenCalledWith(-12345, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
      expect(listeners.size).toBe(0);
    } finally {
      killProcess.mockRestore();
    }
  });
  test("escalates a still-live detached group after the direct child exits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const listeners = new Map<string, (...args: unknown[]) => void>();
    let directChildExited = false;
    const child = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
        return child;
      }),
      removeListener: vi.fn((event: string) => {
        listeners.delete(event);
        return child;
      }),
    };
    const killProcess = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === "SIGTERM") {
        queueMicrotask(() => {
          directChildExited = true;
          listeners.get("exit")?.();
        });
      }
      return true;
    }) as typeof process.kill);
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        _callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => child,
    );

    try {
      const failure = captureApprovedChatGptConversationBackendViaObu({
        targetUrl: "https://chatgpt.com/c/conv-1",
        outDir: "/tmp/oracle-obu-descendant-term-test",
        sessionId: "test-session",
        tabId: "test-tab",
        timeoutMs: 10,
      }).catch((caught: unknown) => caught);

      await vi.advanceTimersByTimeAsync(10);
      await expect(failure).resolves.toMatchObject({
        message: "Timed out waiting for obu cdp Runtime.evaluate.",
      });
      expect(directChildExited).toBe(true);

      await vi.advanceTimersByTimeAsync(100);
      expect(killProcess).toHaveBeenCalledWith(-12345, 0);
      expect(killProcess).toHaveBeenCalledWith(-12345, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
      expect(listeners.size).toBe(0);
    } finally {
      killProcess.mockRestore();
    }
  });
});
