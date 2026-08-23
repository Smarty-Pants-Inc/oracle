import { afterEach, describe, expect, test as it, vi } from "vitest";

const execFileAsyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:util", () => ({ promisify: () => execFileAsyncMock }));

import { captureApprovedChatGptConversationBackendViaObu } from "../../src/browser/chatgptExport.js";
const test = process.platform === "win32" ? it.skip : it;

describe("OBU ChatGPT export cleanup", () => {
  afterEach(() => {
    execFileAsyncMock.mockReset();
  });

  test("cleans the current document when Page.enable fails after hook registration", async () => {
    const events: string[] = [];
    const accountDigest = "a".repeat(64);

    execFileAsyncMock.mockImplementation(async (_file: string, args: string[]) => {
      const method = args[args.indexOf("--method") + 1];
      const params = JSON.parse(args[args.indexOf("--params") + 1]) as {
        expression?: string;
      };
      if (method === "Runtime.evaluate") {
        if (params.expression === "location.href") {
          return {
            stdout: JSON.stringify({
              result: { result: { value: "https://chatgpt.com/c/conv-1" } },
            }),
            stderr: "",
          };
        }
        if (params.expression?.includes("/api/auth/session")) {
          return {
            stdout: JSON.stringify({ result: { result: { value: accountDigest } } }),
            stderr: "",
          };
        }
        if (params.expression?.includes("sessionStorage.removeItem")) {
          events.push("cleanup");
          return {
            stdout: JSON.stringify({ result: { result: { value: true } } }),
            stderr: "",
          };
        }
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        events.push("register-hook");
        return {
          stdout: JSON.stringify({ result: { identifier: "capture-hook" } }),
          stderr: "",
        };
      }
      if (method === "Page.enable") {
        events.push("enable-after-external-reload");
        throw new Error("OBU Page.enable failed after external reload");
      }
      if (method === "Page.removeScriptToEvaluateOnNewDocument") {
        events.push("remove-script");
        return { stdout: JSON.stringify({ result: {} }), stderr: "" };
      }
      throw new Error(`Unexpected OBU CDP method: ${method}`);
    });

    await expect(
      captureApprovedChatGptConversationBackendViaObu({
        targetUrl: "https://chatgpt.com/c/conv-1",
        outDir: "/tmp/oracle-obu-cleanup-race-test",
        sessionId: "test-session",
        tabId: "test-tab",
      }),
    ).rejects.toThrow(/OBU Page\.enable failed after external reload/i);

    expect(events).toEqual([
      "register-hook",
      "enable-after-external-reload",
      "remove-script",
      "cleanup",
    ]);
  });

  test("removes an OBU hook that registers after the bounded export cleanup wait", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const accountDigest = "a".repeat(64);
    const installedHooks = new Set<string>();
    const removedHooks: string[] = [];
    let signalRegistrationStarted!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      signalRegistrationStarted = resolve;
    });
    let resolveRegistration!: () => void;

    execFileAsyncMock.mockImplementation((_file: string, args: string[]) => {
      const method = args[args.indexOf("--method") + 1];
      const params = JSON.parse(args[args.indexOf("--params") + 1]) as {
        expression?: string;
        identifier?: string;
      };
      if (method === "Runtime.evaluate") {
        if (params.expression === "location.href") {
          return Promise.resolve({
            stdout: JSON.stringify({
              result: { result: { value: "https://chatgpt.com/c/conv-1" } },
            }),
            stderr: "",
          });
        }
        if (params.expression?.includes("/api/auth/session")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { result: { value: accountDigest } } }),
            stderr: "",
          });
        }
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        return new Promise<{ stdout: string; stderr: string }>((resolve) => {
          signalRegistrationStarted();
          resolveRegistration = () => {
            installedHooks.add("late-hook");
            resolve({
              stdout: JSON.stringify({ result: { identifier: "late-hook" } }),
              stderr: "",
            });
          };
        });
      }
      if (method === "Page.removeScriptToEvaluateOnNewDocument") {
        if (!params.identifier) throw new Error("Late hook removal was missing its identifier.");
        removedHooks.push(params.identifier);
        installedHooks.delete(params.identifier);
        return Promise.resolve({ stdout: JSON.stringify({ result: {} }), stderr: "" });
      }
      throw new Error(`Unexpected OBU CDP method: ${method}`);
    });

    try {
      const capture = captureApprovedChatGptConversationBackendViaObu({
        targetUrl: "https://chatgpt.com/c/conv-1",
        outDir: "/tmp/oracle-obu-late-registration-test",
        sessionId: "test-session",
        tabId: "test-tab",
        timeoutMs: 10,
      });
      const failure = capture.catch((error: unknown) => error);

      await registrationStarted;
      await vi.advanceTimersByTimeAsync(1_010);

      const error = await failure;
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toMatch(/registration and cleanup failed/i);

      resolveRegistration();
      await vi.advanceTimersByTimeAsync(0);

      expect(removedHooks).toEqual(["late-hook"]);
      expect([...installedHooks]).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports a failed removal for an OBU hook that registers after the export deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const accountDigest = "a".repeat(64);
    const installedHooks = new Set<string>();
    const removalError = new Error("late OBU hook removal failed");
    let signalRegistrationStarted!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      signalRegistrationStarted = resolve;
    });
    let resolveRegistration!: () => void;

    execFileAsyncMock.mockImplementation((_file: string, args: string[]) => {
      const method = args[args.indexOf("--method") + 1];
      const params = JSON.parse(args[args.indexOf("--params") + 1]) as {
        expression?: string;
      };
      if (method === "Runtime.evaluate") {
        if (params.expression === "location.href") {
          return Promise.resolve({
            stdout: JSON.stringify({
              result: { result: { value: "https://chatgpt.com/c/conv-1" } },
            }),
            stderr: "",
          });
        }
        if (params.expression?.includes("/api/auth/session")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { result: { value: accountDigest } } }),
            stderr: "",
          });
        }
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        return new Promise<{ stdout: string; stderr: string }>((resolve) => {
          signalRegistrationStarted();
          resolveRegistration = () => {
            installedHooks.add("late-hook");
            resolve({
              stdout: JSON.stringify({ result: { identifier: "late-hook" } }),
              stderr: "",
            });
          };
        });
      }
      if (method === "Page.removeScriptToEvaluateOnNewDocument") {
        return Promise.reject(removalError);
      }
      throw new Error(`Unexpected OBU CDP method: ${method}`);
    });

    try {
      const capture = captureApprovedChatGptConversationBackendViaObu({
        targetUrl: "https://chatgpt.com/c/conv-1",
        outDir: "/tmp/oracle-obu-late-registration-failure-test",
        sessionId: "test-session",
        tabId: "test-tab",
        timeoutMs: 10,
      });
      const failure = capture.catch((error: unknown) => error);

      await registrationStarted;
      await vi.advanceTimersByTimeAsync(10);
      resolveRegistration();

      const error = await failure;
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toMatch(/registration and cleanup failed/i);
      expect((error as AggregateError).errors).toContain(removalError);
      expect([...installedHooks]).toEqual(["late-hook"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
