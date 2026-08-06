import { createHash } from "node:crypto";
import { createContext, Script } from "node:vm";
import { TextEncoder } from "node:util";
import { describe, expect, test, vi } from "vitest";
import {
  archiveChatGptConversation,
  archiveResultHasCommittedEffectAuthority,
  buildArchiveConversationExpressionForTest,
  isProjectChatgptUrl,
  isTemporaryChatgptUrl,
  resolveBrowserArchiveDecision,
} from "../../src/browser/actions/archiveConversation.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import type { CommittedPromptEpochLocator } from "../../src/browser/reattachability.js";

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
        conversationUrl: "https://chatgpt.com/g/g-p-demo/project/c/abc",
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
    expect(isProjectChatgptUrl("https://chatgpt.com/c/abc")).toBe(false);
  });

  test("detects ChatGPT temporary chat URLs", () => {
    expect(isTemporaryChatgptUrl("https://chatgpt.com/?temporary-chat=true")).toBe(true);
    expect(isTemporaryChatgptUrl("https://chatgpt.com/?temporary-chat=false")).toBe(false);
    expect(isTemporaryChatgptUrl("https://chatgpt.com/c/abc")).toBe(false);
  });
});

const committedPrompt = "archive only this committed conversation";

function committedPromptLocator(conversationId: string): CommittedPromptEpochLocator {
  const promptSha256 = promptIdentitySha256(committedPrompt);
  const epoch = {
    status: "committed" as const,
    epochId: `epoch-${conversationId}`,
    promptSha256,
    baselineTurns: 0,
    followUpOrdinal: 0,
    remainingFollowUps: 0,
    verifiedUserTurnIndex: 0,
    verifiedUserTurnId: `turn-${conversationId}`,
    verifiedUserMessageId: `message-${conversationId}`,
    conversationId,
  };
  return {
    epoch,
    conversationId,
    promptSha256,
    verifiedUserTurnIndex: epoch.verifiedUserTurnIndex,
    verifiedUserTurnId: epoch.verifiedUserTurnId,
    verifiedUserMessageId: epoch.verifiedUserMessageId,
    conversationUrls: [`https://chatgpt.com/c/${conversationId}`],
  };
}

class FakeEvent {
  constructor(
    readonly type: string,
    readonly init?: Record<string, unknown>,
  ) {}
}

class FakeElement {
  readonly children: FakeElement[] = [];
  innerText: string;
  onClick?: () => void;

  constructor(
    readonly textContent: string,
    private readonly attributes: Record<string, string> = {},
    private readonly query: (selector: string) => FakeElement[] = () => [],
  ) {
    this.innerText = textContent;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  matches(selector: string): boolean {
    if (selector.includes('[data-message-author-role="user"]')) {
      return this.attributes["data-message-author-role"] === "user";
    }
    if (selector.includes('[data-turn="user"]')) {
      return this.attributes["data-turn"] === "user";
    }
    if (selector === "[data-message-id]") return Boolean(this.attributes["data-message-id"]);
    return selector.includes("[data-message-content]") && "data-message-content" in this.attributes;
  }

  querySelector(selector: string): FakeElement | null {
    return this.query(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.query(selector);
  }

  closest(): null {
    return null;
  }

  contains(other: FakeElement): boolean {
    return other === this || this.children.includes(other);
  }

  getBoundingClientRect() {
    return { width: 24, height: 24, top: 12, right: 1180, left: 1156 };
  }

  dispatchEvent(event: FakeEvent): boolean {
    if (event.type === "click") this.onClick?.();
    return true;
  }
}

async function runArchiveExpression({
  initialConversationId = "a",
  navigateToConversationId,
  navigateOnSleep,
  navigateOnDigest,
  confirmationRequired = false,
  renderedPrompt = committedPrompt,
}: {
  initialConversationId?: string;
  navigateToConversationId?: string;
  navigateOnSleep?: number;
  navigateOnDigest?: number;
  confirmationRequired?: boolean;
  renderedPrompt?: string;
}) {
  const locator = committedPromptLocator("a");
  const location = { href: `https://chatgpt.com/c/${initialConversationId}` };
  let menuOpen = false;
  let dialogOpen = false;
  let archived = false;
  let archiveClicks = 0;
  let digestCount = 0;
  let sleepCount = 0;
  const promptContent = new FakeElement(renderedPrompt, { "data-message-content": "true" });
  const userTurn = new FakeElement(
    renderedPrompt,
    {
      "data-message-author-role": "user",
      "data-turn-id": locator.verifiedUserTurnId,
      "data-message-id": locator.verifiedUserMessageId,
    },
    (selector) => (selector.includes("data-message-content") ? [promptContent] : []),
  );
  userTurn.children.push(promptContent);
  const menuButton = new FakeElement("Conversation options", {
    "aria-label": "Conversation options",
  });
  const archiveItem = new FakeElement("Archive", { role: "menuitem" });
  const confirmButton = new FakeElement("Archive", { role: "button" });
  const archiveToast = new FakeElement("Conversation archived", { role: "status" });
  menuButton.onClick = () => {
    menuOpen = true;
  };
  archiveItem.onClick = () => {
    if (confirmationRequired) {
      dialogOpen = true;
      return;
    }
    archiveClicks += 1;
    archived = true;
  };
  confirmButton.onClick = () => {
    archiveClicks += 1;
    archived = true;
  };
  const document = {
    querySelectorAll(selector: string): FakeElement[] {
      if (selector === '[data-testid^="conversation-turn"]') return [userTurn];
      if (selector.includes('article[data-testid^="conversation-turn"]')) return [userTurn];
      if (selector === 'button,[role="button"]') return [menuButton];
      if (selector === '[role="menu"]') return [];
      if (selector.includes('[role="menuitem"]')) return menuOpen && !archived ? [archiveItem] : [];
      if (selector.startsWith('[role="dialog"]')) return dialogOpen ? [confirmButton] : [];
      if (selector.startsWith('[role="status"]')) return archived ? [archiveToast] : [];
      return [];
    },
    dispatchEvent: () => true,
  };
  const expression = buildArchiveConversationExpressionForTest("https://chatgpt.com/c/a", locator);
  const hash = async (_algorithm: string, data: Uint8Array) => {
    digestCount += 1;
    if (navigateOnDigest === digestCount && navigateToConversationId) {
      location.href = `https://chatgpt.com/c/${navigateToConversationId}`;
    }
    const digest = createHash("sha256").update(data).digest();
    return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
  };
  const context = createContext({
    Array,
    Date,
    Error,
    HTMLElement: FakeElement,
    KeyboardEvent: FakeEvent,
    MouseEvent: FakeEvent,
    PointerEvent: FakeEvent,
    Promise,
    String,
    TextEncoder,
    Uint8Array,
    URL,
    crypto: { subtle: { digest: hash } },
    document,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    location,
    setTimeout: (resolve: () => void) => {
      sleepCount += 1;
      if (navigateOnSleep === sleepCount && navigateToConversationId) {
        location.href = `https://chatgpt.com/c/${navigateToConversationId}`;
      }
      resolve();
      return sleepCount;
    },
    window: { innerWidth: 1200 },
  });
  const result = await new Script(expression).runInContext(context);
  return { archiveClicks, result };
}

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

  test("rejects a conversation locator that disagrees with the committed prompt epoch", async () => {
    const runtime = { evaluate: vi.fn() };

    await expect(
      archiveChatGptConversation(runtime as never, vi.fn() as never, {
        mode: "always",
        conversationUrl: "https://chatgpt.com/c/b",
        promptLocator: committedPromptLocator("a"),
      }),
    ).resolves.toMatchObject({
      attempted: false,
      archived: false,
      reason: "archive-authority-mismatch",
    });
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  test("does not open the archive effect when durable staging has navigated from A to B", async () => {
    const outcome = await runArchiveExpression({ initialConversationId: "b" });

    expect(outcome.result).toMatchObject({
      status: "skipped",
      reason: "archive-authority-mismatch",
    });
    expect(outcome.archiveClicks).toBe(0);
  });

  test("does not archive B when navigation changes during A's menu interaction", async () => {
    const outcome = await runArchiveExpression({
      navigateOnSleep: 1,
      navigateToConversationId: "b",
    });

    expect(outcome.result).toMatchObject({
      status: "skipped",
      reason: "archive-authority-mismatch",
    });
    expect(outcome.archiveClicks).toBe(0);
  });

  test("rechecks A after the async prompt digest before opening the archive effect", async () => {
    const outcome = await runArchiveExpression({
      navigateOnDigest: 2,
      navigateToConversationId: "b",
    });

    expect(outcome.result).toMatchObject({
      status: "skipped",
      reason: "archive-authority-mismatch",
    });
    expect(outcome.archiveClicks).toBe(0);
  });

  test("does not confirm A's archive after navigation changes to B", async () => {
    const outcome = await runArchiveExpression({
      confirmationRequired: true,
      navigateOnSleep: 2,
      navigateToConversationId: "b",
    });

    expect(outcome.result).toMatchObject({
      status: "skipped",
      reason: "archive-authority-mismatch",
    });
    expect(outcome.archiveClicks).toBe(0);
  });

  test("does not archive when A no longer carries the committed prompt epoch", async () => {
    const outcome = await runArchiveExpression({ renderedPrompt: "a different committed prompt" });

    expect(outcome.result).toMatchObject({
      status: "skipped",
      reason: "archive-authority-mismatch",
    });
    expect(outcome.archiveClicks).toBe(0);
  });

  test("archives exact A only after the committed prompt epoch guard passes", async () => {
    const outcome = await runArchiveExpression({});

    expect(outcome.result).toMatchObject({
      status: "archived",
      conversationUrl: "https://chatgpt.com/c/a",
      effectAuthority: {
        conversationId: "a",
        promptEpoch: {
          epochId: "epoch-a",
          userTurnId: "turn-a",
          userMessageId: "message-a",
        },
      },
    });
    expect(outcome.archiveClicks).toBe(1);
    expect(
      archiveResultHasCommittedEffectAuthority(
        {
          mode: "always",
          attempted: true,
          archived: true,
          ...(outcome.result as object),
        },
        committedPromptLocator("a"),
      ),
    ).toBe(true);
  });

  test("keeps the archive expression scoped to Archive actions", () => {
    const expression = buildArchiveConversationExpressionForTest();
    expect(expression).toContain("findConversationMenuButton");
    expect(expression).toContain("visibleMenuCandidates");
    expect(expression).toContain("findArchiveMenuItem");
    expect(expression).toContain("findArchiveConfirmationButton");
    expect(expression).toContain("hasUnarchiveMenuItem");
    expect(expression).toContain("PointerEvent");
    expect(expression).toContain("runWithArchiveAuthority");
    expect(expression).toContain("waitForArchiveConfirmation");
    expect(expression).toContain("expectedArchiveAuthority");
    expect(expression).toContain("readArchiveAuthoritySnapshot");
    expect(expression).toContain("clickArchiveEffect");
    expect(expression).toContain("Date.now() + 10_000");
    expect(expression).toContain("archive-not-confirmed");
    expect(expression).toContain("archive");
    expect(expression).not.toContain("delete");
  });
});
