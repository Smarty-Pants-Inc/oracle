import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  archiveChatGptConversation,
  buildArchiveConversationExpressionForTest,
  isProjectChatgptUrl,
  isTemporaryChatgptUrl,
  resolveBrowserArchiveDecision,
} from "../../src/browser/actions/archiveConversation.js";

describe("browser conversation archive policy", () => {
  test("archives successful non-project one-shots in auto mode", () => {
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/",
        conversationUrl: "https://chatgpt.com/c/abc",
        researchMode: "off",
        followUpCount: 0,
      }),
    ).toMatchObject({
      mode: "auto",
      shouldArchive: true,
      reason: "successful-one-shot",
    });
  });

  test("auto-archives successful project one-shots", () => {
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/g/g-p-demo/project",
        conversationUrl: "https://chatgpt.com/c/abc",
      }),
    ).toMatchObject({ shouldArchive: true, reason: "successful-one-shot" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/",
        conversationUrl: "https://chatgpt.com/g/g-p-demo/c/abc",
      }),
    ).toMatchObject({ shouldArchive: true, reason: "successful-one-shot" });
  });

  test("does not auto-archive Temporary Chat, Deep Research, multi-turn, or missing-url runs", () => {
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/?temporary-chat=true",
        conversationUrl: "https://chatgpt.com/?temporary-chat=true",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "temporary-chat" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        conversationUrl: "https://chatgpt.com/c/abc",
        researchMode: "deep",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "deep-research" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        conversationUrl: "https://chatgpt.com/c/abc",
        followUpCount: 1,
      }),
    ).toMatchObject({ shouldArchive: false, reason: "multi-turn" });
    expect(resolveBrowserArchiveDecision({ mode: "auto" })).toMatchObject({
      shouldArchive: false,
      reason: "missing-conversation-url",
    });
  });

  test("honors explicit always and never modes", () => {
    expect(resolveBrowserArchiveDecision({ mode: "never", conversationUrl: "x" })).toMatchObject({
      shouldArchive: false,
      reason: "disabled",
    });
    expect(
      resolveBrowserArchiveDecision({
        mode: "always",
        chatgptUrl: "https://chatgpt.com/g/g-p-demo/project",
        conversationUrl: "https://chatgpt.com/c/abc",
        researchMode: "deep",
        followUpCount: 2,
      }),
    ).toMatchObject({ shouldArchive: true, reason: "forced" });
  });

  test("detects ChatGPT project URLs", () => {
    expect(isProjectChatgptUrl("https://chatgpt.com/g/g-p-demo/project")).toBe(true);
    expect(isProjectChatgptUrl("https://chatgpt.com/g/g-p-demo/project?model=gpt-5")).toBe(true);
    expect(isProjectChatgptUrl("https://chatgpt.com/g/g-p-demo/c/abc")).toBe(true);
    expect(isProjectChatgptUrl("https://chatgpt.com/g/g-p-demo/project/c/abc")).toBe(false);
    expect(isProjectChatgptUrl("https://chatgpt.com/c/abc")).toBe(false);
  });

  test("detects ChatGPT temporary chat URLs", () => {
    expect(isTemporaryChatgptUrl("https://chatgpt.com/?temporary-chat=true")).toBe(true);
    expect(isTemporaryChatgptUrl("https://chatgpt.com/?temporary-chat=false")).toBe(false);
    expect(isTemporaryChatgptUrl("https://chatgpt.com/c/abc")).toBe(false);
  });
});

describe("archiveChatGptConversation", () => {
  test("returns archived result when the DOM action succeeds", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { status: "archived", conversationUrl: "https://chatgpt.com/c/abc" } },
      }),
    };
    const logger = vi.fn();

    await expect(
      archiveChatGptConversation(runtime as never, logger as never, {
        mode: "auto",
        conversationUrl: "https://chatgpt.com/c/abc",
      }),
    ).resolves.toMatchObject({
      mode: "auto",
      attempted: true,
      archived: true,
      conversationUrl: "https://chatgpt.com/c/abc",
    });
    expect(runtime.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ awaitPromise: true, returnByValue: true }),
    );
  });

  test("returns a non-archived result when the DOM action is not confirmed", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            status: "skipped",
            reason: "archive-not-confirmed",
            conversationUrl: "https://chatgpt.com/c/abc",
          },
        },
      }),
    };

    await expect(
      archiveChatGptConversation(runtime as never, vi.fn() as never, {
        mode: "always",
        conversationUrl: "https://chatgpt.com/c/abc",
      }),
    ).resolves.toMatchObject({
      mode: "always",
      attempted: true,
      archived: false,
      reason: "archive-not-confirmed",
      conversationUrl: "https://chatgpt.com/c/abc",
    });
  });

  test("returns a non-attempt result when the mutation evaluator rejects affinity", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            status: "skipped",
            reason: "affinity-mismatch",
            conversationUrl: "https://chatgpt.com/c/other",
          },
        },
      }),
    };

    await expect(
      archiveChatGptConversation(runtime as never, vi.fn() as never, {
        mode: "always",
        conversationUrl: "https://chatgpt.com/c/abc",
        expectedAccountDigest: "a".repeat(64),
      }),
    ).resolves.toMatchObject({
      attempted: false,
      archived: false,
      reason: "affinity-mismatch",
    });
  });

  test.each([
    "https://attacker.example/c/abc",
    "https://chatgpt.com:8443/c/abc",
    "https://chatgpt.com/g/g-p-demo/project/c/abc",
  ])(
    "rejects noncanonical conversation URL %s before evaluating the page",
    async (conversationUrl) => {
      const runtime = { evaluate: vi.fn() };

      await expect(
        archiveChatGptConversation(runtime as never, vi.fn() as never, {
          mode: "always",
          conversationUrl,
          expectedAccountDigest: "a".repeat(64),
        }),
      ).resolves.toMatchObject({
        attempted: false,
        archived: false,
        reason: "affinity-mismatch",
      });
      expect(runtime.evaluate).not.toHaveBeenCalled();
    },
  );

  test("checks account affinity inside the evaluator before DOM mutation", async () => {
    const expectedAccountDigest = createHash("sha256").update("account-a").digest("hex");
    const expression = buildArchiveConversationExpressionForTest({
      expectedConversationId: "abc",
      expectedAccountDigest,
    });
    const domAccess = vi.fn();
    const document = new Proxy(
      {},
      {
        get() {
          domAccess();
          throw new Error("DOM mutation path reached");
        },
      },
    );
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { id: "account-b" } }),
    });
    const evaluate = new Function("location", "document", "fetch", `return ${expression};`) as (
      location: { href: string },
      document: object,
      fetch: typeof globalThis.fetch,
    ) => Promise<{
      status: string;
      reason?: string;
    }>;

    await expect(
      evaluate({ href: "https://chatgpt.com/c/abc" }, document, fetch as never),
    ).resolves.toMatchObject({ status: "skipped", reason: "affinity-mismatch" });
    expect(domAccess).not.toHaveBeenCalled();
  });

  test("checks exact ChatGPT origin inside the evaluator before DOM mutation", async () => {
    const expectedAccountDigest = createHash("sha256").update("account-a").digest("hex");
    const expression = buildArchiveConversationExpressionForTest({
      expectedConversationId: "abc",
      expectedAccountDigest,
    });
    const domAccess = vi.fn();
    const document = new Proxy(
      {},
      {
        get() {
          domAccess();
          throw new Error("DOM mutation path reached");
        },
      },
    );
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { id: "account-a" } }),
    });
    const evaluate = new Function("location", "document", "fetch", `return ${expression};`) as (
      location: { href: string },
      document: object,
      fetch: typeof globalThis.fetch,
    ) => Promise<{
      status: string;
      reason?: string;
    }>;

    await expect(
      evaluate({ href: "https://attacker.example/c/abc" }, document, fetch as never),
    ).resolves.toMatchObject({ status: "skipped", reason: "affinity-mismatch" });
    expect(domAccess).not.toHaveBeenCalled();
  });

  test("fails closed when the in-page account probe rejects", async () => {
    const expression = buildArchiveConversationExpressionForTest({
      expectedConversationId: "abc",
      expectedAccountDigest: "a".repeat(64),
    });
    const domAccess = vi.fn();
    const document = new Proxy(
      {},
      {
        get() {
          domAccess();
          throw new Error("DOM mutation path reached");
        },
      },
    );
    const fetch = vi.fn().mockRejectedValue(new Error("session unavailable"));
    const evaluate = new Function("location", "document", "fetch", `return ${expression};`) as (
      location: { href: string },
      document: object,
      fetch: typeof globalThis.fetch,
    ) => Promise<{
      status: string;
      reason?: string;
    }>;

    await expect(
      evaluate({ href: "https://chatgpt.com/c/abc" }, document, fetch as never),
    ).resolves.toMatchObject({ status: "skipped", reason: "affinity-mismatch" });
    expect(domAccess).not.toHaveBeenCalled();
  });

  test("rechecks account affinity after opening the menu and before archive mutation", async () => {
    const expectedAccountDigest = createHash("sha256").update("account-a").digest("hex");
    const expression = buildArchiveConversationExpressionForTest({
      expectedConversationId: "abc",
      expectedAccountDigest,
    });
    class FakeElement {
      textContent = "More";
      dispatchEvent = vi.fn();
      getAttribute(name: string) {
        return name === "aria-label" ? "More" : null;
      }
      getBoundingClientRect() {
        return { left: 1160, right: 1180, top: 10, width: 20, height: 20 };
      }
    }
    const menuButton = new FakeElement();
    const document = {
      querySelectorAll: vi.fn((selector: string) =>
        selector === 'button,[role="button"]' ? [menuButton] : [],
      ),
    };
    const response = (userId: string) => ({
      ok: true,
      json: async () => ({ user: { id: userId } }),
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response("account-a"))
      .mockResolvedValueOnce(response("account-b"));
    const EventStub = class {};
    const evaluate = new Function(
      "location",
      "document",
      "fetch",
      "HTMLElement",
      "getComputedStyle",
      "window",
      "PointerEvent",
      "MouseEvent",
      "setTimeout",
      `return ${expression};`,
    ) as (
      location: { href: string },
      document: object,
      fetch: typeof globalThis.fetch,
      HTMLElement: typeof FakeElement,
      getComputedStyle: () => { visibility: string; display: string },
      window: { innerWidth: number },
      PointerEvent: typeof EventStub,
      MouseEvent: typeof EventStub,
      setTimeout: (callback: () => void) => number,
    ) => Promise<{ status: string; reason?: string }>;

    await expect(
      evaluate(
        { href: "https://chatgpt.com/c/abc" },
        document,
        fetch as never,
        FakeElement,
        () => ({ visibility: "visible", display: "block" }),
        { innerWidth: 1200 },
        EventStub,
        EventStub,
        (callback) => {
          callback();
          return 0;
        },
      ),
    ).resolves.toMatchObject({ status: "skipped", reason: "affinity-mismatch" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(menuButton.dispatchEvent).toHaveBeenCalled();
    expect(document.querySelectorAll).toHaveBeenCalledTimes(1);
  });

  test("keeps the archive expression scoped to Archive actions", () => {
    const expression = buildArchiveConversationExpressionForTest();
    expect(expression).toContain("findConversationMenuButton");
    expect(expression).toContain("visibleMenuCandidates");
    expect(expression).toContain("findArchiveMenuItem");
    expect(expression).toContain("findArchiveConfirmationButton");
    expect(expression).toContain("hasUnarchiveMenuItem");
    expect(expression).toContain("PointerEvent");
    expect(expression).toContain("waitForArchiveConfirmation");
    expect(expression).toContain("Date.now() + 10_000");
    expect(expression).toContain("archive-not-confirmed");
    expect(expression).toContain("archive");
    expect(expression).not.toContain("delete");
  });
});
