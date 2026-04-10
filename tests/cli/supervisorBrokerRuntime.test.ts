import { afterEach, describe, expect, test, vi } from "vitest";
import { __test__ } from "../../src/cli/supervisorBrokerRuntime.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

function runtimeSession(
  id: string,
  status: SessionMetadata["status"],
  startedAt: string,
): SessionMetadata {
  return {
    id,
    createdAt: startedAt,
    startedAt,
    status,
    options: { model: "gpt-5.4-pro" },
    browser: {
      runtime: {
        chromePort: 9222,
      },
    },
  };
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("supervisorBrokerRuntime", () => {
  test("prefers supervisor-style hidden runtimes over attach-running sessions", () => {
    const picked = __test__.pickReusableRuntimeCandidate([
      {
        ...runtimeSession("attach-running-newer", "running", "2026-03-31T10:05:00.000Z"),
        browser: {
          runtime: {
            chromePort: 9222,
          },
          config: {
            attachRunning: true,
          },
        },
      },
      {
        ...runtimeSession("manual-login-older", "completed", "2026-03-31T10:00:00.000Z"),
        browser: {
          runtime: {
            chromePort: 53332,
          },
          config: {
            manualLogin: true,
            keepBrowser: true,
            attachRunning: false,
          },
        },
      },
    ]);

    expect(picked?.id).toBe("manual-login-older");
  });

  test("prefers running reusable runtimes over newer completed sessions", () => {
    const picked = __test__.pickReusableRuntimeCandidate([
      runtimeSession("completed-newer", "completed", "2026-03-31T10:05:00.000Z"),
      runtimeSession("running-older", "running", "2026-03-31T10:00:00.000Z"),
    ]);

    expect(picked?.id).toBe("running-older");
  });

  test("falls back to the newest completed reusable runtime when nothing is running", () => {
    const picked = __test__.pickReusableRuntimeCandidate([
      runtimeSession("completed-older", "completed", "2026-03-31T10:00:00.000Z"),
      runtimeSession("completed-newer", "completed", "2026-03-31T10:05:00.000Z"),
    ]);

    expect(picked?.id).toBe("completed-newer");
  });

  test("skips unreachable hidden runtimes and falls back to the next reachable candidate", async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "ECONNREFUSED" })
      .mockResolvedValueOnce({ ok: true });

    const picked = await __test__.pickReachableRuntimeCandidate(
      [
        {
          ...runtimeSession("attach-running-reachable", "running", "2026-03-31T10:05:00.000Z"),
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 9222,
            },
            config: {
              attachRunning: true,
            },
          },
        },
        {
          ...runtimeSession("hidden-stale", "completed", "2026-03-31T10:00:00.000Z"),
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 53332,
            },
            config: {
              manualLogin: true,
              keepBrowser: true,
              attachRunning: false,
            },
          },
        },
      ],
      probe,
    );

    expect(picked?.id).toBe("attach-running-reachable");
    expect(probe).toHaveBeenNthCalledWith(1, {
      host: "127.0.0.1",
      port: 53332,
      attempts: 1,
      timeoutMs: 1000,
    });
    expect(probe).toHaveBeenNthCalledWith(2, {
      host: "127.0.0.1",
      port: 9222,
      attempts: 1,
      timeoutMs: 1000,
    });
  });

  test("requires an exact reusable tab match for browser websocket runtimes", () => {
    const target = __test__.pickSupervisorRuntimeTarget(
      [
        { targetId: "other-tab", type: "page", url: "https://chatgpt.com/c/other" },
        { targetId: "docs-tab", type: "page", url: "https://example.com/docs" },
      ],
      {
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeTargetId: "missing-tab",
        tabUrl: "https://chatgpt.com/c/expected",
        conversationId: "expected",
      },
      true,
    );

    expect(target).toBeUndefined();
  });

  test("browser websocket runtimes refuse to attach to an arbitrary page target", async () => {
    const connectToRemoteChromeTarget = vi.fn();
    const listRemoteChromeTargets = vi.fn(async () => [
      { targetId: "other-tab", type: "page", url: "https://chatgpt.com/c/other" },
      { targetId: "docs-tab", type: "page", url: "https://example.com/docs" },
    ]);

    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      listRemoteChromeTargets,
    }));

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    await expect(
      connectSupervisorRuntime({
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeTargetId: "missing-tab",
        tabUrl: "https://chatgpt.com/c/expected",
        conversationId: "expected",
      }),
    ).rejects.toThrow(/Unable to locate the existing Oracle browser tab/i);

    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
    expect(connectToRemoteChromeTarget).not.toHaveBeenCalled();
  });
});
