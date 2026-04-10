import { describe, expect, test, vi } from "vitest";
import { __test__, runSupervisorBrokerRequest } from "../../src/cli/supervisorBroker.js";

describe("runSupervisorBrokerRequest", () => {
  test("defaults to run_prompt operation for legacy requests", async () => {
    const runPrompt = vi.fn(async () => ({
      ok: true as const,
      sessionId: "sess-123",
      output: "ok",
    }));
    const response = await runSupervisorBrokerRequest(
      {
        prompt: "hello",
        sessionSlug: "slug-1",
      },
      { runPrompt },
    );

    expect(runPrompt).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ ok: true, sessionId: "sess-123", output: "ok" });
  });

  test("returns list_threads envelope", async () => {
    const listThreads = vi.fn(async () => ({
      ok: true as const,
      threads: [
        {
          title: "Design review",
          conversationId: "abc",
          url: "https://chatgpt.com/c/abc",
        },
      ],
    }));
    const response = await runSupervisorBrokerRequest(
      {
        operation: "list_threads",
        prompt: "",
        sessionSlug: "slug-2",
      },
      { listThreads },
    );

    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      ok: true,
      threads: [
        {
          title: "Design review",
          conversationId: "abc",
          url: "https://chatgpt.com/c/abc",
        },
      ],
    });
  });

  test("accepts legacy action alias for thread operations", async () => {
    const listThreads = vi.fn(async () => ({
      ok: true as const,
      threads: [{ title: "Thread", conversationId: "abc", url: "https://chatgpt.com/c/abc" }],
    }));
    const response = await runSupervisorBrokerRequest(
      {
        action: "list_threads",
        prompt: "",
        sessionSlug: "legacy-action",
      },
      { listThreads },
    );

    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      ok: true,
      threads: [{ title: "Thread", conversationId: "abc", url: "https://chatgpt.com/c/abc" }],
    });
  });

  test("returns the runtime session id for new_thread responses", async () => {
    const newThread = vi.fn(async () => ({
      ok: true as const,
      sessionId: "runtime-1",
      thread: {
        title: "New thread",
        url: "https://chatgpt.com/",
      },
    }));
    const response = await runSupervisorBrokerRequest(
      {
        operation: "new_thread",
        prompt: "",
        sessionSlug: "slug-new",
      },
      { newThread },
    );

    expect(newThread).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      ok: true,
      sessionId: "runtime-1",
      thread: {
        title: "New thread",
        url: "https://chatgpt.com/",
      },
    });
  });

  test("returns the runtime session id for attach_thread responses", async () => {
    const attachThread = vi.fn(async () => ({
      ok: true as const,
      sessionId: "runtime-2",
      thread: {
        title: "Attached thread",
        conversationId: "abc",
        url: "https://chatgpt.com/c/abc",
      },
    }));
    const response = await runSupervisorBrokerRequest(
      {
        operation: "attach_thread",
        prompt: "",
        sessionSlug: "slug-attach",
        conversationId: "abc",
      },
      { attachThread },
    );

    expect(attachThread).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      ok: true,
      sessionId: "runtime-2",
      thread: {
        title: "Attached thread",
        conversationId: "abc",
        url: "https://chatgpt.com/c/abc",
      },
    });
  });

  test("requires conversationId for attach_thread", async () => {
    const response = await runSupervisorBrokerRequest({
      operation: "attach_thread",
      prompt: "",
      sessionSlug: "slug-3",
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain("conversationId");
    }
  });

  test("rejects unsupported operations", async () => {
    const response = await runSupervisorBrokerRequest({
      operation: "unsupported" as "run_prompt",
      prompt: "",
      sessionSlug: "slug-4",
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain("Unsupported supervisor operation");
    }
  });

  test("focus protection is a no-op when no chrome pid is available", async () => {
    const action = vi.fn(async () => "ok");
    const captureFrontmostProcess = vi.fn(async () => "Zed");
    const hideChromeWindow = vi.fn(async () => {});
    const startChromeFocusGuard = vi.fn(() => vi.fn());

    const result = await __test__.withChromeFocusProtection(undefined, action, {
      captureFrontmostProcess,
      hideChromeWindow,
      startChromeFocusGuard,
    } as never);

    expect(result).toBe("ok");
    expect(action).toHaveBeenCalledTimes(1);
    expect(captureFrontmostProcess).not.toHaveBeenCalled();
    expect(hideChromeWindow).not.toHaveBeenCalled();
    expect(startChromeFocusGuard).not.toHaveBeenCalled();
  });

  test("focus protection hides chrome before and after the broker action", async () => {
    const action = vi.fn(async () => "ok");
    const captureFrontmostProcess = vi.fn(async () => "Zed");
    const hideChromeWindow = vi.fn(async () => {});
    const stopFocusGuard = vi.fn();
    const startChromeFocusGuard = vi.fn(() => stopFocusGuard);

    const result = await __test__.withChromeFocusProtection(4242, action, {
      captureFrontmostProcess,
      hideChromeWindow,
      startChromeFocusGuard,
    } as never);

    expect(result).toBe("ok");
    expect(action).toHaveBeenCalledTimes(1);
    expect(captureFrontmostProcess).toHaveBeenCalledTimes(1);
    expect(startChromeFocusGuard).toHaveBeenCalledTimes(1);
    expect(hideChromeWindow).toHaveBeenCalledTimes(2);
    expect(stopFocusGuard).toHaveBeenCalledTimes(1);
  });

  test("focus protection starts before connecting the supervisor runtime", async () => {
    const callOrder: string[] = [];
    const action = vi.fn(async () => {
      callOrder.push("action");
      return "ok";
    });
    const runtimeClose = vi.fn(async () => {
      callOrder.push("close");
    });
    const resolveSupervisorRuntimeContext = vi.fn(async () => {
      callOrder.push("resolve");
      return {
        sessionId: "runtime-1",
        runtime: {
          chromePid: 4242,
        },
      };
    });
    const connectSupervisorRuntime = vi.fn(async () => {
      callOrder.push("connect");
      return {
        client: { Runtime: {} } as never,
        close: runtimeClose,
        host: "127.0.0.1",
        port: 9222,
      };
    });
    const captureFrontmostProcess = vi.fn(async () => {
      callOrder.push("capture");
      return "Zed";
    });
    const hideChromeWindow = vi.fn(async () => {
      callOrder.push("hide");
    });
    const startChromeFocusGuard = vi.fn(() => {
      callOrder.push("start");
      return () => {
        callOrder.push("stop");
      };
    });

    const result = await __test__.withSupervisorRuntime(
      {
        prompt: "",
        sessionSlug: "slug-guard",
      },
      action,
      {
        resolveSupervisorRuntimeContext,
        connectSupervisorRuntime: connectSupervisorRuntime as never,
      },
      {
        captureFrontmostProcess,
        hideChromeWindow,
        startChromeFocusGuard,
      } as never,
    );

    expect(result).toBe("ok");
    expect(callOrder).toEqual([
      "resolve",
      "capture",
      "start",
      "hide",
      "connect",
      "action",
      "close",
      "stop",
      "hide",
    ]);
  });
});
