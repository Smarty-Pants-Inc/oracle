import { describe, expect, test, vi } from "vitest";
import {
  assertChatGptIdentity,
  ensureChatGptIdentity,
  __test__,
  type ChatGptIdentityExpectation,
} from "../../src/browser/chatgptAccountRouter.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";

const accountDigest = "a".repeat(64);
const oldWorkspaceDigest = "b".repeat(64);
const expectedWorkspaceDigest = "c".repeat(64);
const expectation: ChatGptIdentityExpectation = {
  email: "paul@smartypants.ai",
  workspaceName: "Paul Bettner",
  accountDigest,
  workspaceDigest: expectedWorkspaceDigest,
};

function runtimeFromValues(values: unknown[]): ChromeClient["Runtime"] {
  const evaluate = vi.fn(async () => ({ result: { value: values.shift() } }));
  return { evaluate } as unknown as ChromeClient["Runtime"];
}

function inputRecorder(): ChromeClient["Input"] {
  return {
    dispatchMouseEvent: vi.fn(async () => ({})),
  } as unknown as ChromeClient["Input"];
}

describe("ChatGPT account router", () => {
  test("strictly verifies account and workspace digests", async () => {
    const Runtime = runtimeFromValues([
      {
        status: "authenticated",
        email: expectation.email,
        accountDigest,
        workspaceDigest: expectedWorkspaceDigest,
      },
    ]);
    await expect(assertChatGptIdentity(Runtime, expectation)).resolves.toMatchObject(expectation);
  });

  test("asks Paul to reauthenticate when the routed login is unavailable", async () => {
    const Runtime = runtimeFromValues([{ status: "unauthenticated" }]);
    await expect(assertChatGptIdentity(Runtime, expectation)).rejects.toMatchObject({
      message: expect.stringMatching(
        /open chatgpt\.com, choose Add account, sign in to paul@smartypants\.ai/i,
      ),
      details: {
        stage: "main-chrome-account-router",
        code: "login-required",
        expectedEmail: "paul@smartypants.ai",
        expectedWorkspace: "Paul Bettner",
      },
    });
  });

  test("classifies auth-session 401 and 403 responses as unauthenticated", () => {
    const expression = __test__.buildSessionIdentityExpression();
    expect(expression).toContain("response.status === 401 || response.status === 403");
    expect(expression).toContain("return { status: 'unauthenticated' }");
  });
  test("does not misreport an identity probe outage as expired login", async () => {
    vi.useFakeTimers();
    try {
      const Runtime = runtimeFromValues(
        Array.from({ length: 50 }, () => ({ status: "unavailable" })),
      );
      const assertion = expect(assertChatGptIdentity(Runtime, expectation)).rejects.toMatchObject({
        details: {
          stage: "main-chrome-account-router",
          code: "identity-unavailable",
        },
      });
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("binds an account switch to its exact workspace row", async () => {
    vi.useFakeTimers();
    try {
      const oldIdentity = {
        status: "authenticated",
        email: expectation.email,
        accountDigest,
        workspaceDigest: oldWorkspaceDigest,
      };
      const selectedIdentity = {
        status: "authenticated",
        email: expectation.email,
        accountDigest,
        workspaceDigest: expectedWorkspaceDigest,
      };
      const Runtime = runtimeFromValues([
        {
          status: "authenticated",
          email: "other@example.com",
          accountDigest: "d".repeat(64),
          workspaceDigest: "e".repeat(64),
        },
        { status: "clicked", x: 100, y: 200 },
        true,
        oldIdentity,
        oldIdentity,
        { status: "clicked", x: 120, y: 220 },
        true,
        oldIdentity,
        selectedIdentity,
        { status: "selected" },
      ]);
      const Input = inputRecorder();
      const assertion = expect(
        ensureChatGptIdentity(
          Runtime,
          Input,
          { ...expectation, accountDigest: null, workspaceDigest: null },
          vi.fn() as BrowserLogger,
        ),
      ).resolves.toMatchObject({
        email: expectation.email,
        accountDigest,
        workspaceDigest: expectedWorkspaceDigest,
      });
      await vi.runAllTimersAsync();
      await assertion;
      expect(Runtime.evaluate).toHaveBeenCalledTimes(10);
      expect(Input.dispatchMouseEvent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  test("does not promote the account switcher's selected workspace without a settled workspace proof", async () => {
    vi.useFakeTimers();
    try {
      const targetAccountOldWorkspace = {
        status: "authenticated",
        email: expectation.email,
        accountDigest,
        workspaceDigest: oldWorkspaceDigest,
      };
      const Runtime = runtimeFromValues([
        {
          status: "authenticated",
          email: "other@example.com",
          accountDigest: "d".repeat(64),
          workspaceDigest: "e".repeat(64),
        },
        { status: "selected" },
        targetAccountOldWorkspace,
        ...Array.from({ length: 50 }, () => ({ status: "not-found" })),
      ]);

      const assertion = expect(
        ensureChatGptIdentity(
          Runtime,
          inputRecorder(),
          { ...expectation, accountDigest: null, workspaceDigest: null },
          vi.fn() as BrowserLogger,
        ),
      ).rejects.toMatchObject({
        details: { stage: "main-chrome-account-router", code: "workspace-required" },
      });
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not accept the old workspace after clicking a first-use named workspace", async () => {
    const Runtime = runtimeFromValues([
      {
        status: "authenticated",
        email: expectation.email,
        accountDigest,
        workspaceDigest: oldWorkspaceDigest,
      },
      { status: "clicked", x: 100, y: 200 },
      true,
      {
        status: "authenticated",
        email: expectation.email,
        accountDigest,
        workspaceDigest: oldWorkspaceDigest,
      },
      {
        status: "authenticated",
        email: expectation.email,
        accountDigest,
        workspaceDigest: expectedWorkspaceDigest,
      },
      { status: "selected" },
    ]);
    const logger = vi.fn() as BrowserLogger;
    const Input = inputRecorder();
    const firstUse = { ...expectation, workspaceDigest: null };
    await expect(ensureChatGptIdentity(Runtime, Input, firstUse, logger)).resolves.toMatchObject({
      workspaceDigest: expectedWorkspaceDigest,
    });
    expect((Runtime.evaluate as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6);
    expect(Input.dispatchMouseEvent).toHaveBeenCalledOnce();
  });
  test("accepts a first-use route when the exact workspace row is already selected", async () => {
    const Runtime = runtimeFromValues([
      {
        status: "authenticated",
        email: expectation.email,
        accountDigest,
        workspaceDigest: expectedWorkspaceDigest,
      },
      { status: "selected" },
      {
        status: "authenticated",
        email: expectation.email,
        accountDigest,
        workspaceDigest: expectedWorkspaceDigest,
      },
      { status: "selected" },
    ]);
    const Input = inputRecorder();
    await expect(
      ensureChatGptIdentity(
        Runtime,
        Input,
        { ...expectation, workspaceDigest: null },
        vi.fn() as BrowserLogger,
      ),
    ).resolves.toMatchObject({
      email: expectation.email,
      workspaceDigest: expectedWorkspaceDigest,
    });
    expect(Input.dispatchMouseEvent).not.toHaveBeenCalled();
  });
  test("does not accept a stale digest after clicking a differently named workspace", async () => {
    vi.useFakeTimers();
    try {
      const Runtime = runtimeFromValues([
        {
          status: "authenticated",
          email: expectation.email,
          accountDigest,
          workspaceDigest: expectedWorkspaceDigest,
        },
        { status: "clicked", x: 100, y: 200 },
        true,
        ...Array.from({ length: 50 }, () => ({
          status: "authenticated",
          email: expectation.email,
          accountDigest,
          workspaceDigest: expectedWorkspaceDigest,
        })),
      ]);
      const assertion = expect(
        ensureChatGptIdentity(Runtime, inputRecorder(), expectation, vi.fn() as BrowserLogger),
      ).rejects.toMatchObject({
        details: { stage: "main-chrome-account-router", code: "workspace-required" },
      });
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  test("does not accept a matching digest without the named workspace row", async () => {
    vi.useFakeTimers();
    try {
      const Runtime = runtimeFromValues([
        {
          status: "authenticated",
          email: expectation.email,
          accountDigest,
          workspaceDigest: expectedWorkspaceDigest,
        },
        { status: "menu-opened", x: 100, y: 200 },
        true,
        ...Array.from({ length: 50 }, () => ({
          status: "authenticated",
          email: expectation.email,
          accountDigest,
          workspaceDigest: expectedWorkspaceDigest,
        })),
      ]);
      const assertion = expect(
        ensureChatGptIdentity(Runtime, inputRecorder(), expectation, vi.fn() as BrowserLogger),
      ).rejects.toMatchObject({
        details: { stage: "main-chrome-account-router", code: "workspace-required" },
      });
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  test("rejects a clicked workspace whose active identity never changes", async () => {
    vi.useFakeTimers();
    try {
      const Runtime = runtimeFromValues([
        {
          status: "authenticated",
          email: expectation.email,
          accountDigest,
          workspaceDigest: oldWorkspaceDigest,
        },
        { status: "clicked", x: 100, y: 200 },
        true,
        ...Array.from({ length: 50 }, () => ({
          status: "authenticated",
          email: expectation.email,
          accountDigest,
          workspaceDigest: oldWorkspaceDigest,
        })),
      ]);
      const Input = inputRecorder();
      const assertion = expect(
        ensureChatGptIdentity(
          Runtime,
          Input,
          { ...expectation, workspaceDigest: null },
          vi.fn() as BrowserLogger,
        ),
      ).rejects.toMatchObject({
        details: {
          stage: "main-chrome-account-router",
          code: "workspace-required",
        },
      });
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("matches one leaf identity only inside visible account menus", () => {
    const expression = __test__.buildMenuActionExpression(
      "email",
      expectation.email,
      true,
      expectation.workspaceName,
    );
    expect(expression).toContain("const menuActionable");
    expect(expression).toContain("let targetMatches = menuActionable.filter(matchesTarget)");
    expect(expression).toContain("const leafMatches = targetMatches.filter");
    expect(expression).toContain("if (leafMatches.length > 1) return { status: 'ambiguous' }");
    expect(expression).toContain("found.length === 1 && found[0] === expected");
    expect(expression).toContain(
      "accountRows.filter((node) => matchesWorkspace(node, accountWorkspace))",
    );
    expect(expression).not.toContain("const match = actionable.find(matchesTarget)");
  });

  test("scopes workspace rows to the settled target account", () => {
    const expression = __test__.buildMenuActionExpression(
      "workspace",
      expectation.workspaceName,
      true,
      expectation.workspaceName,
      expectation.email,
    );
    expect(expression).toContain(`const accountEmail = "${expectation.email}"`);
    expect(expression).toContain("const accountMatches = menuActionable.filter");
    expect(expression).toContain("targetMatches = accountRows.filter(matchesTarget)");
  });

  test("opens the nested current-account switcher with hover then a full pointer sequence", () => {
    const expression = __test__.buildMenuActionExpression("email", "dev1@smartypants.ai");
    const clickExpression = __test__.buildPointerClickExpression(120, 808);
    expect(expression).toContain("(?:personal|business|team|enterprise)\\s+account");
    expect(expression).toContain("clickPoint(currentAccount, 'switcher-opened')");
    expect(expression).toContain("rightRect.width * rightRect.height");
    expect(expression).toContain("x: rect.left + rect.width / 2 - Math.min(10, rect.width / 4)");
    expect(clickExpression).toContain("document.elementFromPoint(x, y)");
    expect(clickExpression).toContain("new PointerEvent('pointerdown'");
    expect(clickExpression).toContain("new MouseEvent('click'");
  });
  test("finds a profile control implemented as a role button", () => {
    const expression = __test__.buildMenuActionExpression("workspace", expectation.workspaceName);
    expect(expression).toContain('[role="button"][aria-label*="open profile menu" i]');
  });
  test("opens the current-account switcher for workspace routing", () => {
    const expression = __test__.buildMenuActionExpression(
      "workspace",
      expectation.workspaceName,
      true,
      expectation.workspaceName,
      expectation.email,
    );
    expect(expression).toContain("if (!account) {");
    expect(expression).toContain("clickPoint(currentAccount, 'switcher-opened')");
  });

  test("fails closed when more than one account row matches", async () => {
    const Runtime = runtimeFromValues([
      {
        status: "authenticated",
        email: "other@example.com",
        accountDigest: "d".repeat(64),
        workspaceDigest: "e".repeat(64),
      },
      { status: "ambiguous" },
    ]);

    await expect(
      ensureChatGptIdentity(Runtime, inputRecorder(), expectation, vi.fn() as BrowserLogger),
    ).rejects.toMatchObject({
      details: {
        stage: "main-chrome-account-router",
        code: "email-menu-ambiguous",
      },
    });
  });

  test("fails immediately if the authenticated account changes mid-run", async () => {
    const Runtime = runtimeFromValues([
      {
        status: "authenticated",
        email: "personal@example.com",
        accountDigest: "d".repeat(64),
        workspaceDigest: "e".repeat(64),
      },
    ]);
    const error = await assertChatGptIdentity(Runtime, expectation).catch((caught) => caught);
    expect(error).toMatchObject({
      message: expect.stringMatching(/account changed during the Oracle run/i),
      details: {
        stage: "main-chrome-account-router",
        code: "account-identity-mismatch",
        expectedEmail: expectation.email,
      },
    });
    expect(error.details).not.toHaveProperty("observedEmail");
  });
});
