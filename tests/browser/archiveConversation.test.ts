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

  test("checks workspace affinity inside the evaluator before DOM mutation", async () => {
    const expectedAccountDigest = createHash("sha256").update("account-a").digest("hex");
    const expectedWorkspaceDigest = createHash("sha256").update("workspace-a").digest("hex");
    const expression = buildArchiveConversationExpressionForTest({
      expectedRoute: "/g/project-a/c/abc",
      expectedAccountDigest,
      expectedWorkspaceDigest,
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
      json: async () => ({
        user: { id: "account-a" },
        account: { id: "workspace-b" },
      }),
    });
    const evaluate = new Function("location", "document", "fetch", `return ${expression};`) as (
      location: { href: string },
      document: object,
      fetch: typeof globalThis.fetch,
    ) => Promise<{ status: string; reason?: string }>;

    await expect(
      evaluate({ href: "https://chatgpt.com/g/project-a/c/abc" }, document, fetch as never),
    ).resolves.toMatchObject({ status: "skipped", reason: "affinity-mismatch" });
    expect(domAccess).not.toHaveBeenCalled();
  });

  test("checks the exact root or project route inside the evaluator before DOM mutation", async () => {
    const expression = buildArchiveConversationExpressionForTest({
      expectedRoute: "/g/project-a/c/abc",
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
    const evaluate = new Function("location", "document", `return ${expression};`) as (
      location: { href: string },
      document: object,
    ) => Promise<{ status: string; reason?: string }>;

    await expect(evaluate({ href: "https://chatgpt.com/c/abc" }, document)).resolves.toMatchObject({
      status: "skipped",
      reason: "affinity-mismatch",
    });
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

  test("rechecks workspace affinity after opening the menu and before archive mutation", async () => {
    const expectedAccountDigest = createHash("sha256").update("account-a").digest("hex");
    const expectedWorkspaceDigest = createHash("sha256").update("workspace-a").digest("hex");
    const expression = buildArchiveConversationExpressionForTest({
      expectedConversationId: "abc",
      expectedAccountDigest,
      expectedWorkspaceDigest,
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
    const response = (workspaceId: string) => ({
      ok: true,
      json: async () => ({
        user: { id: "account-a" },
        account: { id: workspaceId },
      }),
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response("workspace-a"))
      .mockResolvedValueOnce(response("workspace-b"));
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
    expect(document.querySelectorAll).toHaveBeenCalledTimes(2);
  });

  test("does not select sidebar history controls as the conversation menu", async () => {
    const expression = buildArchiveConversationExpressionForTest();
    class FakeElement {
      tagName: string;
      parentElement: FakeElement | null;
      textContent = "More";
      dispatchEvent = vi.fn();

      constructor(tagName: string, parentElement: FakeElement | null = null) {
        this.tagName = tagName;
        this.parentElement = parentElement;
      }

      getAttribute(name: string) {
        return name === "aria-label" ? "More" : null;
      }

      getBoundingClientRect() {
        return { left: 1160, right: 1180, top: 10, width: 20, height: 20 };
      }
    }
    const body = new FakeElement("BODY");
    const sidebar = new FakeElement("NAV", body);
    const menuButton = new FakeElement("BUTTON", sidebar);
    const document = {
      body,
      querySelectorAll: vi.fn((selector: string) =>
        selector === 'button,[role="button"]' ? [menuButton] : [],
      ),
    };
    const EventStub = class {};
    const evaluate = new Function(
      "location",
      "document",
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
      HTMLElement: typeof FakeElement,
      getComputedStyle: () => {
        visibility: string;
        display: string;
        opacity: string;
        pointerEvents: string;
      },
      window: { innerWidth: number },
      PointerEvent: typeof EventStub,
      MouseEvent: typeof EventStub,
      setTimeout: (callback: () => void) => number,
    ) => Promise<{ status: string; reason?: string }>;

    await expect(
      evaluate(
        { href: "https://chatgpt.com/c/abc" },
        document,
        FakeElement,
        () => ({ visibility: "visible", display: "block", opacity: "1", pointerEvents: "auto" }),
        { innerWidth: 1200 },
        EventStub,
        EventStub,
        () => 0,
      ),
    ).resolves.toMatchObject({ status: "skipped", reason: "conversation-menu-not-found" });
    expect(menuButton.dispatchEvent).not.toHaveBeenCalled();
  });

  test("compares full canonical affinity for ancestor conversation links", async () => {
    const evaluateCandidate = async (expectedRoute: string, href: string) => {
      const expression = buildArchiveConversationExpressionForTest({ expectedRoute });
      class FakeElement {
        tagName: string;
        parentElement: FakeElement | null;
        href?: string;
        textContent = "More";
        dispatchEvent = vi.fn();

        constructor(tagName: string, parentElement: FakeElement | null = null, href?: string) {
          this.tagName = tagName;
          this.parentElement = parentElement;
          this.href = href;
        }

        getAttribute(name: string) {
          if (name === "aria-label") return "More";
          return name === "href" ? (this.href ?? null) : null;
        }

        getBoundingClientRect() {
          return { left: 1160, right: 1180, top: 10, width: 20, height: 20 };
        }
      }
      const body = new FakeElement("BODY");
      const linkedConversation = new FakeElement("A", body, href);
      const menuButton = new FakeElement("BUTTON", linkedConversation);
      const document = {
        body,
        dispatchEvent: vi.fn(),
        querySelectorAll: vi.fn((selector: string) =>
          selector === 'button,[role="button"]' ? [menuButton] : [],
        ),
      };
      const EventStub = class {};
      const evaluate = new Function(
        "location",
        "document",
        "HTMLElement",
        "getComputedStyle",
        "window",
        "PointerEvent",
        "MouseEvent",
        "KeyboardEvent",
        "setTimeout",
        `return ${expression};`,
      ) as (
        location: { href: string },
        document: object,
        HTMLElement: typeof FakeElement,
        getComputedStyle: () => {
          visibility: string;
          display: string;
          opacity: string;
          pointerEvents: string;
        },
        window: { innerWidth: number },
        PointerEvent: typeof EventStub,
        MouseEvent: typeof EventStub,
        KeyboardEvent: typeof EventStub,
        setTimeout: (callback: () => void) => number,
      ) => Promise<{ status: string; reason?: string }>;

      const result = await evaluate(
        { href: `https://chatgpt.com${expectedRoute}` },
        document,
        FakeElement,
        () => ({ visibility: "visible", display: "block", opacity: "1", pointerEvents: "auto" }),
        { innerWidth: 1200 },
        EventStub,
        EventStub,
        EventStub,
        (callback) => {
          callback();
          return 0;
        },
      );
      return { result, menuButton };
    };

    const differentProject = await evaluateCandidate("/g/project-A/c/abc", "/g/project-B/c/abc");
    expect(differentProject.result).toMatchObject({
      status: "skipped",
      reason: "conversation-menu-not-found",
    });
    expect(differentProject.menuButton.dispatchEvent).not.toHaveBeenCalled();

    const stableProjectId = "g-p-0123456789abcdef0123456789abcdef";
    const stableSuffixVariant = await evaluateCandidate(
      `/g/${stableProjectId}-project-a/c/abc`,
      `/g/${stableProjectId}-project-b/c/abc`,
    );
    expect(stableSuffixVariant.result).toMatchObject({
      status: "skipped",
      reason: "conversation-menu-not-owned",
    });
    expect(stableSuffixVariant.menuButton.dispatchEvent).toHaveBeenCalled();
  });

  test("does not claim archive success after leaving the approved thread", async () => {
    const expression = buildArchiveConversationExpressionForTest();
    let currentUrl = "https://chatgpt.com/c/abc";
    let menuOpen = false;
    let archiveItem: object | undefined;
    let menuButton: object | undefined;
    class FakeElement {
      tagName: string;
      parentElement: FakeElement | null;
      textContent: string;
      dispatchEvent = vi.fn((event: { type?: string }) => {
        if (event.type === "click" && this === archiveItem) {
          currentUrl = "https://chatgpt.com/";
        }
        if (event.type === "click" && this === menuButton) menuOpen = true;
        return true;
      });

      constructor(tagName: string, textContent: string, parentElement: FakeElement | null = null) {
        this.tagName = tagName;
        this.textContent = textContent;
        this.parentElement = parentElement;
      }

      getAttribute(name: string) {
        return name === "aria-label" ? this.textContent : null;
      }

      getBoundingClientRect() {
        return { left: 1160, right: 1180, top: 10, width: 20, height: 20 };
      }

      querySelectorAll(selector: string) {
        if (
          this === menuRoot &&
          selector === '[role="menuitem"],[role="option"],button,div[tabindex],a'
        ) {
          return archiveItem ? [archiveItem] : [];
        }
        return [];
      }
    }
    const body = new FakeElement("BODY", "");
    const menuRoot = new FakeElement("DIV", "", body);
    const moreButton = new FakeElement("BUTTON", "More", body);
    const archive = new FakeElement("DIV", "Archive", menuRoot);
    menuButton = moreButton;
    archiveItem = archive;
    const location = {
      get href() {
        return currentUrl;
      },
    };
    const document = {
      body,
      dispatchEvent: vi.fn(),
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === 'button,[role="button"]') return [moreButton];
        if (selector === '[role="menu"],[role="listbox"]') return menuOpen ? [menuRoot] : [];
        return [];
      }),
    };
    class EventStub {
      type?: string;
      constructor(type?: string) {
        this.type = type;
      }
    }
    const evaluate = new Function(
      "location",
      "document",
      "HTMLElement",
      "getComputedStyle",
      "window",
      "PointerEvent",
      "MouseEvent",
      "KeyboardEvent",
      "setTimeout",
      `return ${expression};`,
    ) as (
      location: { href: string },
      document: object,
      HTMLElement: typeof FakeElement,
      getComputedStyle: () => {
        visibility: string;
        display: string;
        opacity: string;
        pointerEvents: string;
      },
      window: { innerWidth: number },
      PointerEvent: typeof EventStub,
      MouseEvent: typeof EventStub,
      KeyboardEvent: typeof EventStub,
      setTimeout: (callback: () => void) => number,
    ) => Promise<{ status: string; reason?: string }>;

    await expect(
      evaluate(
        location,
        document,
        FakeElement,
        () => ({ visibility: "visible", display: "block", opacity: "1", pointerEvents: "auto" }),
        { innerWidth: 1200 },
        EventStub,
        EventStub,
        EventStub,
        (callback) => {
          callback();
          return 0;
        },
      ),
    ).resolves.toMatchObject({ status: "skipped", reason: "affinity-mismatch" });
    expect(archive.dispatchEvent).toHaveBeenCalled();
  });

  test("keeps the archive expression scoped to Archive actions", () => {
    const expression = buildArchiveConversationExpressionForTest();
    expect(expression).toContain("findConversationMenuButton");
    expect(expression).toContain("belongsToOtherConversation");
    expect(expression).toContain("visibleDialogRoots");
    expect(expression).toContain("openedDialogs.length !== 1");
    expect(expression).toContain("visibleMenuCandidates");
    expect(expression).toContain("findArchiveMenuItem");
    expect(expression).toContain("findArchiveConfirmationButton");
    expect(expression).toContain("PointerEvent");
    expect(expression).toContain("waitForArchiveConfirmation");
    expect(expression).toContain("headerCandidates.length === 1");
    expect(expression).toContain("resolveOwnedMenuRoot");
    expect(expression).toContain("conversation-menu-not-owned");
    expect(expression).toContain("style.opacity");
    expect(expression).toContain("style.pointerEvents");
    expect(expression).toContain("(?=-|$)");
    expect(expression).not.toContain("?? labelled[0]");
    expect(expression).not.toContain("menuRoots.length > 0 ? menuRoots : [document]");
    expect(expression).toContain("Date.now() + 10_000");
    expect(expression).toContain("archive-not-confirmed");
    expect(expression).toContain("archive");
    expect(expression).not.toContain("delete");
  });
});
