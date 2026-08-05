import { beforeEach, describe, expect, test, vi } from "vitest";
import type { BrowserRunResult, BrowserRunTransaction } from "../../src/browser/types.js";

const { runLocalBrowserMode, runRemoteBrowserMode } = vi.hoisted(() => ({
  runLocalBrowserMode: vi.fn(),
  runRemoteBrowserMode: vi.fn(),
}));

vi.mock("../../src/browser/localBrowserCoordinator.js", () => ({ runLocalBrowserMode }));
vi.mock("../../src/browser/remoteBrowserCoordinator.js", () => ({ runRemoteBrowserMode }));

import { runBrowserMode, runBrowserModeTransaction } from "../../src/browser/browserCoordinator.js";

const capture: BrowserRunResult = {
  answerText: "settled answer",
  answerMarkdown: "settled answer",
  tookMs: 250,
  answerTokens: 2,
  answerChars: 14,
  browserTransport: "cdp",
  chromeHost: "remote.example",
  chromePort: 9333,
  chromeTargetId: "owned-target",
};

function browserTransaction(
  finalize: BrowserRunTransaction["finalize"],
  abort: BrowserRunTransaction["abort"] = vi.fn(async () => ({
    status: "completed" as const,
    runtime: {},
  })),
  runtime: BrowserRunTransaction["runtime"] = {},
): BrowserRunTransaction {
  return {
    ...capture,
    runtime,
    bindSettlement: vi.fn(async () => runtime),
    finalize,
    abort,
  };
}

describe("browser coordinator public settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("finalizes a successful direct run before returning an audit-safe result", async () => {
    const runtime = { chromeTargetId: "owned-target" };
    const finalize = vi.fn(async () => ({ status: "completed" as const, runtime }));
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime }));
    runRemoteBrowserMode.mockResolvedValueOnce(browserTransaction(finalize, abort, runtime));

    const result = await runBrowserMode({
      prompt: "review this",
      config: { remoteChrome: { host: "remote.example", port: 9333 } },
    });

    expect(finalize).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(result).toEqual({
      answerText: "settled answer",
      answerMarkdown: "settled answer",
      tookMs: 250,
      answerTokens: 2,
      answerChars: 14,
      browserTransport: "cdp",
    });
    expect(result).not.toHaveProperty("runtime");
    expect(result).not.toHaveProperty("chromeHost");
    expect(result).not.toHaveProperty("chromePort");
    expect(result).not.toHaveProperty("chromeTargetId");
    expect(result).not.toHaveProperty("finalize");
    expect(result).not.toHaveProperty("bindSettlement");
    expect(result).not.toHaveProperty("abort");
  });

  test("keeps settlement under the explicit transaction entrypoint caller", async () => {
    const finalize = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    const transaction = browserTransaction(finalize);
    runRemoteBrowserMode.mockResolvedValueOnce(transaction);

    await expect(
      runBrowserModeTransaction({
        prompt: "persist before cleanup",
        config: { remoteChrome: { host: "remote.example", port: 9333 } },
      }),
    ).resolves.toBe(transaction);
    expect(finalize).not.toHaveBeenCalled();
  });

  test("returns the captured answer without publishing pending cleanup authority", async () => {
    const runtime: BrowserRunTransaction["runtime"] = {
      chromeHost: "remote.example",
      chromePort: 9333,
      chromeTargetId: "owned-target",
      recoveryCleanupResources: [
        {
          chromeHost: "remote.example",
          chromePort: 9333,
          chromeTargetId: "owned-target",
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "temporary",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
      recoveryCleanupResult: {
        status: "failed",
        settlementMode: "finalize",
        error: "Remote Chrome target close was not confirmed",
      },
    };
    const finalize = vi.fn(async () => ({
      status: "pending" as const,
      runtime,
      error: "Remote Chrome target close was not confirmed",
    }));
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime }));
    runRemoteBrowserMode.mockResolvedValueOnce(browserTransaction(finalize, abort, runtime));

    const result = await runBrowserMode({
      prompt: "review this",
      config: { remoteChrome: { host: "remote.example", port: 9333 } },
    });

    expect(result).toMatchObject({
      answerText: "settled answer",
      answerMarkdown: "settled answer",
      warnings: [
        {
          code: "direct-finalize-cleanup-pending",
          severity: "warning",
          message:
            "The assistant answer is complete, but internal browser cleanup remains pending.",
          details: { stage: "browser-capture-finalization" },
        },
      ],
    });
    expect(result).not.toHaveProperty("runtime");
    expect(result).not.toHaveProperty("chromeHost");
    expect(result).not.toHaveProperty("chromePort");
    expect(result).not.toHaveProperty("chromeTargetId");
    expect(result).not.toHaveProperty("recoveryCleanupResources");
    expect(finalize).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
  });
});
