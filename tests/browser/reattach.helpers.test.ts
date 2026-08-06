import { describe, expect, test, vi } from "vitest";
import type { SessionBoundChromeClient } from "../../src/browser/chromeSessionTransport.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { selectTarget } from "../../src/browser/reattachTargetSelection.js";
import { __test__ } from "../../src/browser/reattach.js";
import { createBrowserLogger } from "./reattachTestHelpers.js";

describe("reattach helpers", () => {
  const {
    extractConversationIdFromUrl,
    buildConversationUrl,
    openConversationFromSidebar,
    createOwnedRecoveryTargetConnection,
  } = __test__;
  type EvaluateParams = { expression: string };
  type EvaluateResult<T> = { result: { value: T } };
  test("extracts conversation id from a chat URL", () => {
    expect(extractConversationIdFromUrl("https://chatgpt.com/c/abc-123")).toBe("abc-123");
    expect(
      extractConversationIdFromUrl(
        "https://chatgpt.com/c/WEB:32229414-5afa-4478-890c-9ca80aa82430",
      ),
    ).toBeUndefined();
    expect(extractConversationIdFromUrl("")).toBeUndefined();
  });

  test("builds conversation URL from tabUrl or conversationId", () => {
    expect(
      buildConversationUrl(
        { tabUrl: "https://chatgpt.com/c/live", conversationId: "ignored" },
        "https://chatgpt.com/",
      ),
    ).toBe("https://chatgpt.com/c/live");
    expect(buildConversationUrl({ conversationId: "abc" }, "https://chatgpt.com/")).toBe(
      "https://chatgpt.com/c/abc",
    );
  });

  test("creates and binds a dedicated owned recovery target through exact authority", async () => {
    const logger = createBrowserLogger();
    const closeConnection = vi.fn(async () => undefined);
    const endpointAuthority = {
      browserWSEndpoint: "ws://127.0.0.1:63333/devtools/browser/generation-a",
      kill: vi.fn(),
      runExactOperation: vi.fn(),
      release: vi.fn(),
    };
    const connectRecoveryTargetWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
      value: {
        client: { close: vi.fn(async () => undefined) } as unknown as SessionBoundChromeClient,
        browserClient: {
          Browser: { getWindowForTarget: vi.fn(), setWindowBounds: vi.fn() },
          Target: { getTargets: vi.fn(), getTargetInfo: vi.fn() },
        },
        targetId: "created-target",
        ownership: "created" as const,
        close: closeConnection,
      },
    }));

    const connection = await createOwnedRecoveryTargetConnection(
      "test-owner",
      endpointAuthority as never,
      "generation-a",
      logger,
      { connectRecoveryTargetWithExactAuthority: connectRecoveryTargetWithExactAuthority as never },
      "about:blank#oracle-acquisition=generation-a",
    );

    expect(connectRecoveryTargetWithExactAuthority).toHaveBeenCalledWith({
      authority: endpointAuthority,
      targetUrl: "about:blank#oracle-acquisition=generation-a",
      closeTargetOnDispose: false,
    });
    expect(connection).toMatchObject({ targetId: "created-target", ownership: "created" });
    await connection.close();
    expect(closeConnection).toHaveBeenCalledOnce();
  });

  test("failure-closes an acquired recovery target only through exact authority", async () => {
    const logger = createBrowserLogger();
    const closeConnection = vi.fn(async () => undefined);
    const closeChromeTargetWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
    }));
    const endpointAuthority = {
      browserWSEndpoint: "ws://127.0.0.1:63333/devtools/browser/generation-a",
      kill: vi.fn(),
      runExactOperation: vi.fn(),
      release: vi.fn(),
    };

    await expect(
      createOwnedRecoveryTargetConnection(
        "test-owner",
        endpointAuthority as never,
        "generation-a",
        logger,
        {
          connectRecoveryTargetWithExactAuthority: vi.fn(async () => ({
            status: "completed" as const,
            value: {
              client: {
                close: vi.fn(async () => undefined),
              } as unknown as SessionBoundChromeClient,
              browserClient: {
                Browser: { getWindowForTarget: vi.fn(), setWindowBounds: vi.fn() },
                Target: { getTargets: vi.fn(), getTargetInfo: vi.fn() },
              },
              targetId: "created-target",
              ownership: "created" as const,
              close: closeConnection,
            },
          })) as never,
          recoveryCleanup: { closeChromeTargetWithExactAuthority },
        },
        undefined,
        async () => {
          throw new Error("target journal unavailable");
        },
      ),
    ).rejects.toThrow("target journal unavailable");
    expect(closeConnection).toHaveBeenCalledOnce();
    expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledWith({
      authority: endpointAuthority,
      targetId: "created-target",
      logger,
    });
  });

  test("does not acquire a recovery target from generation B after generation A exits", async () => {
    const generationBCreateTarget = vi.fn();
    const generationBAttachTarget = vi.fn();
    const endpointAuthority = {
      browserWSEndpoint: "ws://127.0.0.1:63333/devtools/browser/generation-a",
      kill: vi.fn(),
      runExactOperation: vi.fn(),
      release: vi.fn(),
    };
    const connectRecoveryTargetWithExactAuthority = vi.fn(async () => ({
      status: "gone" as const,
    }));

    await expect(
      createOwnedRecoveryTargetConnection(
        "test-owner",
        endpointAuthority as never,
        "generation-a",
        createBrowserLogger(),
        {
          connectRecoveryTargetWithExactAuthority: connectRecoveryTargetWithExactAuthority as never,
        },
      ),
    ).rejects.toThrow(/generation exited/i);
    expect(generationBCreateTarget).not.toHaveBeenCalled();
    expect(generationBAttachTarget).not.toHaveBeenCalled();
  });

  test("selectTarget requires the stored target and committed conversation to match", () => {
    const targets = [
      { targetId: "t-1", type: "page", url: "https://chatgpt.com/c/first" },
      { targetId: "t-2", type: "page", url: "https://chatgpt.com/c/second" },
      { targetId: "t-3", type: "page", url: "about:blank" },
    ];
    expect(
      selectTarget(targets, {
        chromeTargetId: "t-1",
        tabUrl: "https://chatgpt.com/c/first",
        conversationId: "first",
      }),
    ).toEqual({ status: "selected", target: targets[0], targetId: "t-1" });
    expect(
      selectTarget(targets, {
        chromeTargetId: "t-2",
        tabUrl: "https://chatgpt.com/c/first",
        conversationId: "first",
      }),
    ).toEqual({ status: "missing" });
    expect(selectTarget(targets, { tabUrl: "https://chatgpt.com/c/first" })).toEqual({
      status: "missing",
    });
    expect(selectTarget(targets, {})).toEqual({ status: "mismatched" });
    expect(
      selectTarget([{ targetId: "external", type: "page", url: "https://example.com/c/first" }], {
        chromeTargetId: "external",
        conversationId: "first",
      }),
    ).toEqual({ status: "missing" });
  });

  test("selectTarget permits only an explicitly referenced borrowed target", () => {
    const targets = [
      { targetId: "t-1", type: "page", url: "https://chatgpt.com/c/first" },
      { targetId: "t-2", type: "page", url: "https://chatgpt.com/c/second" },
    ];
    expect(selectTarget(targets, { conversationId: "second" }, "t-2")).toEqual({
      status: "selected",
      target: targets[1],
      targetId: "t-2",
    });
    expect(selectTarget(targets, { conversationId: "second" }, "second")).toEqual({
      status: "selected",
      target: targets[1],
      targetId: "t-2",
    });
    expect(selectTarget(targets, { conversationId: "second" }, "missing")).toEqual({
      status: "missing",
    });
    expect(selectTarget(targets, { conversationId: "second" }, "current")).toEqual({
      status: "unsupported",
    });
    const ambiguous = [
      { targetId: "same-1", type: "page", url: "https://chatgpt.com/c/same" },
      { targetId: "same-2", type: "page", url: "https://chatgpt.com/c/same" },
    ];
    expect(selectTarget(ambiguous, { conversationId: "same" }, "same")).toEqual({
      status: "ambiguous",
    });
    expect(
      selectTarget(ambiguous, { conversationId: "same" }, "https://chatgpt.com/c/same"),
    ).toEqual({ status: "ambiguous" });
  });

  test("selectTarget keeps the saved target among duplicate conversation tabs", () => {
    const targets = [
      { targetId: "duplicate", type: "page", url: "https://chatgpt.com/c/same" },
      { targetId: "submitted", type: "page", url: "https://chatgpt.com/c/same" },
    ];

    expect(
      selectTarget(targets, {
        chromeTargetId: "submitted",
        conversationId: "same",
      }),
    ).toEqual({ status: "selected", target: targets[1], targetId: "submitted" });
  });

  test("selectTarget understands CDP list ids when conversation identity agrees", () => {
    const targets = [
      { id: "page-1", type: "page", url: "https://chatgpt.com/c/first" },
      { id: "page-2", type: "page", url: "about:blank" },
    ];

    expect(
      selectTarget(targets, {
        chromeTargetId: "page-1",
        conversationId: "first",
      }),
    ).toEqual({ status: "selected", target: targets[0], targetId: "page-1" });
  });

  test("openConversationFromSidebar passes conversationId and projects preference", async () => {
    const evaluate = vi.fn<
      (
        params: EvaluateParams,
      ) => Promise<EvaluateResult<{ ok: boolean; href?: string; count: number }>>
    >(async () => ({
      result: { value: { ok: true, href: "https://chatgpt.com/c/abc", count: 3 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, {
      conversationId: "abc",
      preferProjects: true,
    });

    expect(ok).toBe(true);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain('const conversationId = "abc"');
    expect(call?.expression).toContain("const preferProjects = true");
  });
});
