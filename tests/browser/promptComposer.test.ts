import { describe, expect, test, vi } from "vitest";
import {
  __test__ as promptComposer,
  clearPromptComposer,
  submitPrompt,
} from "../../src/browser/actions/promptComposer.js";
import { buildReadUserPromptTextExpression } from "../../src/browser/actions/committedPrompt.js";
import {
  capturePromptTooLargeRejectionBaseline,
  verifyPromptCommitted,
} from "../../src/browser/actions/promptCommitVerification.js";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
} from "../../src/browser/constants.js";
import { verifyCommittedPromptTurn } from "../../src/browser/actions/assistantResponse.js";
import type { CommittedPromptEpochLocator } from "../../src/browser/reattachability.js";
import { runSubmissionWithRecoveryForTest } from "../../src/browser/promptSubmissionCoordinator.js";

describe("promptComposer", () => {
  test("fails composer clearing when stale text remains", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { cleared: true, remaining: ["old draft"] } },
      }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(clearPromptComposer(runtime as never, logger as never)).rejects.toThrow(
      /Failed to clear prompt composer/,
    );
  });

  test("refuses commit verification without a finite pre-dispatch baseline", async () => {
    const runtime = { evaluate: vi.fn() };

    await expect(
      verifyPromptCommitted(runtime as never, "hello", 150, undefined, Number.NaN),
    ).rejects.toMatchObject({
      details: { stage: "submit-prompt", code: "prompt-baseline-unavailable" },
    });
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  test("commits and revalidates only authored Markdown prompt content from a decorated user turn", async () => {
    const submittedPrompt = "Assess `const answer = 42`.";
    const promptContent = {
      innerText: "Assess const answer = 42.",
      textContent: "Assess const answer = 42.",
      getAttribute: (name: string) => (name === "data-message-content" ? "" : null),
      matches: (selector: string) => selector.includes("[data-message-content]"),
      closest: () => null,
      contains: () => false,
    };
    const attachmentCard = {
      innerText: "brief.md",
      textContent: "brief.md",
      getAttribute(name: string) {
        if (name === "data-message-content") return "";
        if (name === "data-testid") return "attachment-card";
        return null;
      },
      matches: (selector: string) => selector.includes("[data-message-content]"),
      closest: (selector: string) =>
        selector.includes('[data-testid*="attachment"]') ? attachmentCard : null,
      contains: () => false,
    };
    const actionControl = {
      innerText: "Edit",
      textContent: "Edit",
      getAttribute: (name: string) => (name === "data-message-content" ? "" : null),
      matches: (selector: string) => selector.includes("[data-message-content]"),
      closest: (selector: string) => (selector.includes("button") ? actionControl : null),
      contains: () => false,
    };
    const nestedUser = {
      dataset: { messageId: "nested-message" },
      getAttribute(name: string): string | null {
        if (name === "data-turn") return "user";
        if (name === "data-message-id") return "nested-message";
        return null;
      },
      matches: (selector: string) => selector.includes('[data-turn="user"]'),
      querySelector: () => null,
      querySelectorAll(selector: string) {
        return selector.includes("[data-message-content]")
          ? [promptContent, attachmentCard, actionControl]
          : [];
      },
    };
    const container = {
      // The outer turn text is deliberately not identity authority.
      innerText: "You said: Assess const answer = 42. Edit brief.md",
      textContent: "You said: Assess const answer = 42. Edit brief.md",
      dataset: { turnId: "nested-turn" },
      getAttribute(name: string): string | null {
        if (name === "data-testid") return "conversation-turn-nested";
        if (name === "data-turn-id") return "nested-turn";
        return null;
      },
      matches: () => false,
      querySelector(selector: string) {
        if (selector.includes('[data-turn="user"]')) return nestedUser;
        if (selector === "[data-message-id]") return nestedUser;
        return null;
      },
      querySelectorAll(selector: string) {
        return selector.includes('[data-turn="user"]') ? [nestedUser] : [];
      },
    };
    const document = {
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (
          selector === CONVERSATION_TURN_CONTAINER_SELECTOR ||
          selector === CONVERSATION_TURN_SELECTOR
        ) {
          return [container];
        }
        return [];
      },
    };
    class FakeTextArea {}
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: Function(
            "document",
            "HTMLTextAreaElement",
            "location",
            `return ${expression};`,
          )(document, FakeTextArea, { href: "https://chatgpt.com/c/nested-user" }),
        },
      })),
    };

    const committed = await verifyPromptCommitted(
      runtime as never,
      submittedPrompt,
      150,
      undefined,
      0,
    );
    const locator: CommittedPromptEpochLocator = {
      epoch: {
        status: "committed",
        epochId: "nested-user-prompt-epoch-0",
        promptSha256: committed.promptSha256,
        baselineTurns: 0,
        followUpOrdinal: 0,
        remainingFollowUps: 0,
        verifiedUserTurnIndex: committed.verifiedUserTurnIndex,
        verifiedUserTurnId: committed.verifiedUserTurnId,
        verifiedUserMessageId: committed.verifiedUserMessageId,
        conversationId: committed.conversationId,
      },
      conversationId: committed.conversationId,
      promptSha256: committed.promptSha256,
      verifiedUserTurnIndex: committed.verifiedUserTurnIndex,
      verifiedUserTurnId: committed.verifiedUserTurnId,
      verifiedUserMessageId: committed.verifiedUserMessageId,
      conversationUrls: ["https://chatgpt.com/c/nested-user"],
    };

    await expect(verifyCommittedPromptTurn(runtime as never, locator)).resolves.toBeUndefined();
  });

  test("classifies an exact accepted long prompt without stable ids as identity-unavailable", async () => {
    vi.useFakeTimers();
    try {
      const acceptedLongPrompt = "x".repeat(50_000);
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              baseline: 0,
              turnsCount: 1,
              matchedUserTurnIndex: 0,
              matchedUserTurnId: null,
              matchedUserMessageId: null,
              matchedUserTurnText: acceptedLongPrompt,
              conversationId: "conversation-1",
            },
          },
        }),
      };
      const pending = verifyPromptCommitted(
        runtime as never,
        acceptedLongPrompt,
        150,
        undefined,
        0,
      );
      const assertion = pending.then(
        () => {
          throw new Error("expected verifyPromptCommitted to reject");
        },
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(250);
      const error = (await assertion) as { details?: Record<string, unknown> };
      expect(error).toMatchObject({
        details: {
          stage: "submit-prompt",
          code: "prompt-commit-identity-unavailable",
          commitProbe: {
            matchedUserTurnIndex: 0,
            matchedUserTurnIdPresent: false,
            matchedUserMessageIdPresent: false,
            matchedUserTurnLength: acceptedLongPrompt.length,
          },
        },
      });
      expect(error.details?.code).not.toBe("prompt-too-large");
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not send a fallback after an exact accepted long prompt lacks stable ids", async () => {
    vi.useFakeTimers();
    try {
      const acceptedLongPrompt = "x".repeat(50_000);
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              baseline: 0,
              turnsCount: 1,
              matchedUserTurnIndex: 0,
              matchedUserTurnId: null,
              matchedUserMessageId: null,
              matchedUserTurnText: acceptedLongPrompt,
              conversationId: "conversation-1",
            },
          },
        }),
      };
      const submit = vi.fn(async () => {
        await verifyPromptCommitted(runtime as never, acceptedLongPrompt, 150, undefined, 0);
        throw new Error("accepted prompt unexpectedly produced committed identity");
      });
      const prepareFallbackSubmission = vi.fn().mockResolvedValue(undefined);
      const pending = runSubmissionWithRecoveryForTest({
        prompt: acceptedLongPrompt,
        attachments: [],
        fallbackSubmission: { prompt: "fallback prompt", attachments: [] },
        submit,
        reloadPromptComposer: vi.fn().mockResolvedValue(undefined),
        prepareFallbackSubmission,
        logger: Object.assign(vi.fn(), { verbose: false }),
      });
      const assertion = expect(pending).rejects.toMatchObject({
        details: { code: "prompt-commit-identity-unavailable" },
      });

      await vi.advanceTimersByTimeAsync(250);
      await assertion;
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith(acceptedLongPrompt, []);
      expect(prepareFallbackSubmission).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not fallback when React replaces a stale oversized alert with identical semantics", async () => {
    vi.useFakeTimers();
    try {
      const acceptedLongPrompt = "x".repeat(50_000);
      const staleAlert = {
        innerText: "The message you submitted was too long. Please submit something shorter.",
        textContent: "The message you submitted was too long. Please submit something shorter.",
        getBoundingClientRect: () => ({ width: 320, height: 40 }),
      };
      let visibleAlert = staleAlert;
      const acceptedTurnWithoutText = {
        dataset: { turn: "user" },
        getAttribute: (name: string) =>
          name === "data-message-author-role" || name === "data-turn" ? "user" : null,
        matches: (selector: string) => selector.includes('[data-message-author-role="user"]'),
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      const document = {
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (
            selector === CONVERSATION_TURN_CONTAINER_SELECTOR ||
            selector === CONVERSATION_TURN_SELECTOR
          ) {
            return [acceptedTurnWithoutText];
          }
          return selector === '[role="alert"]' ? [visibleAlert] : [];
        },
      };
      class FakeTextArea {}
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: Function(
              "document",
              "HTMLTextAreaElement",
              "location",
              `return ${expression};`,
            )(document, FakeTextArea, { href: "https://chatgpt.com/c/conversation-1" }),
          },
        })),
      };
      const rejectionBaseline = await capturePromptTooLargeRejectionBaseline(runtime as never);
      expect(Object.values(rejectionBaseline?.fingerprintCounts ?? {})).toEqual([1]);
      visibleAlert = { ...staleAlert };
      const submit = vi.fn(async () => {
        await verifyPromptCommitted(
          runtime as never,
          acceptedLongPrompt,
          150,
          undefined,
          0,
          rejectionBaseline,
        );
        throw new Error("ambiguous accepted prompt unexpectedly committed");
      });
      const prepareFallbackSubmission = vi.fn().mockResolvedValue(undefined);
      const pending = runSubmissionWithRecoveryForTest({
        prompt: acceptedLongPrompt,
        attachments: [],
        fallbackSubmission: { prompt: "fallback prompt", attachments: [] },
        submit,
        reloadPromptComposer: vi.fn().mockResolvedValue(undefined),
        prepareFallbackSubmission,
        logger: Object.assign(vi.fn(), { verbose: false }),
      });
      const assertion = expect(pending).rejects.toMatchObject({
        details: {
          code: "prompt-commit-timeout",
          commitProbe: {
            hasPostBaselineUserTurn: true,
            promptTooLargeRejectedForDispatch: false,
          },
        },
      });

      await vi.advanceTimersByTimeAsync(250);
      await assertion;
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith(acceptedLongPrompt, []);
      expect(prepareFallbackSubmission).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not fallback when stale and replacement oversized alerts transiently overlap", async () => {
    vi.useFakeTimers();
    try {
      const acceptedLongPrompt = "x".repeat(50_000);
      const staleAlert = {
        innerText: "The message you submitted was too long. Please submit something shorter.",
        textContent: "The message you submitted was too long. Please submit something shorter.",
        getBoundingClientRect: () => ({ width: 320, height: 40 }),
      };
      let visibleAlerts = [staleAlert];
      const acceptedTurnWithoutText = {
        dataset: { turn: "user" },
        getAttribute: (name: string) =>
          name === "data-message-author-role" || name === "data-turn" ? "user" : null,
        matches: (selector: string) => selector.includes('[data-message-author-role="user"]'),
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      const document = {
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (
            selector === CONVERSATION_TURN_CONTAINER_SELECTOR ||
            selector === CONVERSATION_TURN_SELECTOR
          ) {
            return [acceptedTurnWithoutText];
          }
          return selector === '[role="alert"]' ? visibleAlerts : [];
        },
      };
      class FakeTextArea {}
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: Function(
              "document",
              "HTMLTextAreaElement",
              "location",
              `return ${expression};`,
            )(document, FakeTextArea, { href: "https://chatgpt.com/c/conversation-1" }),
          },
        })),
      };
      const rejectionBaseline = await capturePromptTooLargeRejectionBaseline(runtime as never);
      expect(Object.values(rejectionBaseline?.fingerprintCounts ?? {})).toEqual([1]);
      visibleAlerts = [staleAlert, { ...staleAlert }];
      const submit = vi.fn(async () => {
        await verifyPromptCommitted(
          runtime as never,
          acceptedLongPrompt,
          150,
          undefined,
          0,
          rejectionBaseline,
        );
        throw new Error("ambiguous accepted prompt unexpectedly committed");
      });
      const prepareFallbackSubmission = vi.fn().mockResolvedValue(undefined);
      const pending = runSubmissionWithRecoveryForTest({
        prompt: acceptedLongPrompt,
        attachments: [],
        fallbackSubmission: { prompt: "fallback prompt", attachments: [] },
        submit,
        reloadPromptComposer: vi.fn().mockResolvedValue(undefined),
        prepareFallbackSubmission,
        logger: Object.assign(vi.fn(), { verbose: false }),
      });
      const assertion = expect(pending).rejects.toMatchObject({
        details: {
          code: "prompt-commit-timeout",
          commitProbe: {
            hasPostBaselineUserTurn: true,
            promptTooLargeRejectedForDispatch: false,
          },
        },
      });

      await vi.advanceTimersByTimeAsync(250);
      await assertion;
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith(acceptedLongPrompt, []);
      expect(prepareFallbackSubmission).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses the fallback after ChatGPT visibly rejects an oversized prompt", async () => {
    vi.useFakeTimers();
    try {
      const oversizedPrompt = "x".repeat(50_000);
      const rejectionBaseline = {
        fingerprintCounts: {},
      };
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              baseline: 0,
              turnsCount: 0,
              matchedUserTurnIndex: null,
              matchedUserTurnId: null,
              matchedUserMessageId: null,
              matchedUserTurnText: null,
              hasPostBaselineUserTurn: false,
              hasNewTurn: false,
              composerCleared: false,
              promptTooLargeRejectedForDispatch: true,
              conversationId: null,
            },
          },
        }),
      };
      const fallbackResult = {
        baselineTurns: 0,
        baselineAssistantText: "",
        promptLocator: {
          epoch: {
            status: "committed" as const,
            epochId: "fallback-epoch",
            promptSha256: "a".repeat(64),
            baselineTurns: 0,
            followUpOrdinal: 0,
            remainingFollowUps: 0,
            verifiedUserTurnIndex: 0,
            verifiedUserTurnId: "fallback-turn",
            verifiedUserMessageId: "fallback-message",
            conversationId: "fallback-conversation",
          },
          conversationId: "fallback-conversation",
          promptSha256: "a".repeat(64),
          verifiedUserTurnIndex: 0,
          verifiedUserTurnId: "fallback-turn",
          verifiedUserMessageId: "fallback-message",
          conversationUrls: ["https://chatgpt.com/c/fallback-conversation"],
        },
      };
      const submit = vi.fn(async (submittedPrompt: string) => {
        if (submittedPrompt === oversizedPrompt) {
          await verifyPromptCommitted(
            runtime as never,
            oversizedPrompt,
            150,
            undefined,
            0,
            rejectionBaseline,
          );
          throw new Error("oversized prompt unexpectedly committed");
        }
        return fallbackResult;
      });
      const prepareFallbackSubmission = vi.fn().mockResolvedValue(undefined);
      const pending = runSubmissionWithRecoveryForTest({
        prompt: oversizedPrompt,
        attachments: [],
        fallbackSubmission: { prompt: "fallback prompt", attachments: [] },
        submit,
        reloadPromptComposer: vi.fn().mockResolvedValue(undefined),
        prepareFallbackSubmission,
        logger: Object.assign(vi.fn(), { verbose: false }),
      });
      const assertion = expect(pending).resolves.toBe(fallbackResult);

      await vi.advanceTimersByTimeAsync(250);
      await assertion;
      expect(submit).toHaveBeenCalledTimes(2);
      expect(submit).toHaveBeenNthCalledWith(1, oversizedPrompt, []);
      expect(submit).toHaveBeenNthCalledWith(2, "fallback prompt", []);
      expect(prepareFallbackSubmission).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not treat historical assistant content as committed without a new turn", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          // Baseline read (turn count)
          .mockResolvedValueOnce({ result: { value: 10 } })
          // Polls (repeat)
          .mockResolvedValue({
            result: {
              value: {
                baseline: 10,
                turnsCount: 10,
                userMatched: false,
                prefixMatched: false,
                lastMatched: false,
                hasNewTurn: false,
                stopVisible: true,
                assistantVisible: true,
                composerCleared: true,
                inConversation: false,
              },
            },
          }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = verifyPromptCommitted(runtime as never, "hello", 150, undefined, 10);
      // Attach the rejection handler before timers advance to avoid unhandled-rejection warnings.
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not count nested broad-selector matches as new turns in a reused conversation", async () => {
    vi.useFakeTimers();
    try {
      const topLevelTurns = [{ innerText: "old user" }, { innerText: "old assistant" }];
      const nestedMatches = [
        topLevelTurns[0],
        { innerText: "old user" },
        topLevelTurns[1],
        { innerText: "old assistant" },
      ];
      const document = {
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === CONVERSATION_TURN_CONTAINER_SELECTOR) return topLevelTurns;
          if (selector === CONVERSATION_TURN_SELECTOR) return nestedMatches;
          return [];
        },
      };
      class FakeTextArea {}
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: Function(
              "document",
              "HTMLTextAreaElement",
              "location",
              `return ${expression};`,
            )(document, FakeTextArea, { href: "https://chatgpt.com/c/reused" }),
          },
        })),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = verifyPromptCommitted(runtime as never, "new prompt", 150, undefined, 2);
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("commit timeout throws a structured error with probe diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const probe = {
        baseline: 10,
        turnsCount: 10,
        userMatched: false,
        prefixMatched: false,
        lastMatched: false,
        hasNewTurn: false,
        stopVisible: false,
        assistantVisible: false,
        composerCleared: true,
        inConversation: false,
        editorValue: "",
        lastTurn: "previous turn text",
      };
      const runtime = {
        evaluate: vi
          .fn()
          // Baseline read (turn count)
          .mockResolvedValueOnce({ result: { value: 10 } })
          // Polls + final diagnostic probe
          .mockResolvedValue({ result: { value: probe } }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = verifyPromptCommitted(runtime as never, "hello", 150, undefined, 10);
      const assertion = promise.then(
        () => {
          throw new Error("expected verifyPromptCommitted to reject");
        },
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(250);
      const error = (await assertion) as {
        name?: string;
        details?: Record<string, unknown>;
        message?: string;
      };
      expect(error.message).toMatch(/prompt did not appear/i);
      expect(error.name).toBe("BrowserAutomationError");
      expect(error.details).toMatchObject({
        stage: "submit-prompt",
        code: "prompt-commit-timeout",
        commitProbe: expect.objectContaining({
          hasNewTurn: false,
          composerCleared: true,
          turnsCount: 10,
          lastTurnLength: "previous turn text".length,
        }),
      });
      // Free text must not leak into the structured details.
      const commitProbe = error.details?.commitProbe as Record<string, unknown>;
      expect(commitProbe).not.toHaveProperty("lastTurn");
      expect(commitProbe).not.toHaveProperty("editorValue");
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not let a historical repeated prompt authorize an unrelated new turn", async () => {
    vi.useFakeTimers();
    try {
      const makeTurn = (role: "user" | "assistant", text: string, index: number) => {
        const promptContent = {
          innerText: text,
          textContent: text,
          getAttribute: (name: string) => (name === "data-message-content" ? "" : null),
          matches: (selector: string) => selector.includes("[data-message-content]"),
          closest: () => null,
          contains: () => false,
        };
        const node = {
          innerText: text,
          textContent: text,
          id: `conversation-turn-${index}`,
          dataset: {
            turn: role,
            turnId: `turn-${index}`,
            messageId: `message-${index}`,
          },
          getAttribute(name: string) {
            if (name === "data-message-author-role" || name === "data-turn") return role;
            if (name === "data-turn-id") return `turn-${index}`;
            if (name === "data-message-id") return `message-${index}`;
            return null;
          },
          matches(selector: string) {
            return (
              selector === "[data-message-id]" ||
              (role === "user" && selector.includes('[data-message-author-role="user"]'))
            );
          },
          querySelector(selector: string) {
            if (selector === "[data-message-id]") {
              return {
                dataset: { messageId: `message-${index}` },
                getAttribute: () => `message-${index}`,
              };
            }
            return null;
          },
          querySelectorAll(selector: string) {
            return role === "user" && selector.includes("[data-message-content]")
              ? [promptContent]
              : [];
          },
        };
        return node;
      };
      const topLevelTurns = [
        makeTurn("user", "repeat this prompt", 0),
        makeTurn("assistant", "historical answer", 1),
        makeTurn("user", "an unrelated new prompt", 2),
      ];
      const document = {
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === CONVERSATION_TURN_CONTAINER_SELECTOR) return topLevelTurns;
          if (selector === CONVERSATION_TURN_SELECTOR) return topLevelTurns;
          return [];
        },
      };
      class FakeTextArea {}
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: Function(
              "document",
              "HTMLTextAreaElement",
              "location",
              `return ${expression};`,
            )(document, FakeTextArea, { href: "https://chatgpt.com/c/repeated-prompt" }),
          },
        })),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = verifyPromptCommitted(
        runtime as never,
        "repeat this prompt",
        150,
        undefined,
        2,
      );
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects a new user turn that shares the first 120 characters but has a different suffix", async () => {
    vi.useFakeTimers();
    try {
      const sharedPrefix = "x".repeat(120);
      const intendedPrompt = `${sharedPrefix} intended suffix`;
      const observedPrompt = `${sharedPrefix} unrelated suffix`;
      const promptContent = {
        innerText: observedPrompt,
        textContent: observedPrompt,
        getAttribute: (name: string) => (name === "data-message-content" ? "" : null),
        matches: (selector: string) => selector.includes("[data-message-content]"),
        closest: () => null,
        contains: () => false,
      };
      const turn = {
        innerText: observedPrompt,
        textContent: observedPrompt,
        id: "conversation-turn-0",
        dataset: { turn: "user", turnId: "turn-0", messageId: "message-0" },
        getAttribute(name: string) {
          if (name === "data-message-author-role" || name === "data-turn") return "user";
          if (name === "data-turn-id") return "turn-0";
          if (name === "data-message-id") return "message-0";
          return null;
        },
        matches: (selector: string) =>
          selector === "[data-message-id]" ||
          selector.includes('[data-message-author-role="user"]'),
        querySelector: () => null,
        querySelectorAll: (selector: string) =>
          selector.includes("[data-message-content]") ? [promptContent] : [],
      };
      const document = {
        querySelector: () => null,
        querySelectorAll: (selector: string) =>
          selector === CONVERSATION_TURN_CONTAINER_SELECTOR ||
          selector === CONVERSATION_TURN_SELECTOR
            ? [turn]
            : [],
      };
      class FakeTextArea {}
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: Function(
              "document",
              "HTMLTextAreaElement",
              "location",
              `return ${expression};`,
            )(document, FakeTextArea, { href: "https://chatgpt.com/c/exact-suffix" }),
          },
        })),
      };

      const pending = verifyPromptCommitted(runtime as never, intendedPrompt, 150, undefined, 0);
      const assertion = expect(pending).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects a stable user turn when its authored content subtree is missing", async () => {
    const messageNode = {
      dataset: { messageId: "message-0" },
      getAttribute: (name: string) => (name === "data-message-id" ? "message-0" : null),
    };
    const turn = {
      innerText: "Exact prompt text",
      textContent: "Exact prompt text",
      dataset: { turn: "user" },
      getAttribute(name: string) {
        if (name === "data-message-author-role" || name === "data-turn") return "user";
        if (name === "data-testid") return "conversation-turn-0";
        return null;
      },
      matches: () => false,
      querySelector: (selector: string) => (selector === "[data-message-id]" ? messageNode : null),
    };
    const document = {
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === CONVERSATION_TURN_CONTAINER_SELECTOR || selector === CONVERSATION_TURN_SELECTOR
          ? [turn]
          : [],
    };
    class FakeTextArea {}
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: Function(
            "document",
            "HTMLTextAreaElement",
            "location",
            `return ${expression};`,
          )(document, FakeTextArea, { href: "https://chatgpt.com/c/exact-conversation" }),
        },
      })),
    };

    await expect(
      verifyPromptCommitted(runtime as never, "Exact prompt text", 150, undefined, 0),
    ).rejects.toThrow(/prompt did not appear/i);
  });

  test("rejects ambiguous authored prompt content", () => {
    const content = (text: string) => ({
      innerText: text,
      textContent: text,
      getAttribute: (name: string) => (name === "data-message-content" ? "" : null),
      matches: (selector: string) => selector.includes("[data-message-content]"),
      closest: () => null,
      contains: () => false,
    });
    const turn = {
      matches: (selector: string) => selector.includes('[data-message-author-role="user"]'),
      querySelectorAll: (selector: string) =>
        selector.includes("[data-message-content]")
          ? [content("first prompt block"), content("second prompt block")]
          : [],
    };
    const readPromptText = Function(
      "turn",
      `${buildReadUserPromptTextExpression()} return readUserPromptText(turn);`,
    ) as (node: typeof turn) => string | null;

    expect(readPromptText(turn)).toBeNull();
  });

  test("attachment sends time out instead of allowing Enter fallback", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("dispatchClickSequence")) {
            return { result: { value: { status: "disabled" } } };
          }
          return { result: { value: true } };
        }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.attemptSendButton(
        runtime as never,
        (() => undefined) as never,
        undefined,
        ["oracle-attach-verify.txt"],
      );
      const assertion = expect(promise).rejects.toThrow(/after 45s/i);
      await vi.advanceTimersByTimeAsync(46_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("checks an enabled attachment send button even when secondary evidence is stale", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("const expected =")) {
          return { result: { value: false } };
        }
        return { result: { value: { status: "point", x: 10, y: 20 } } };
      });
      const input = { dispatchMouseEvent: vi.fn().mockResolvedValue(undefined) };
      const pending = promptComposer.attemptSendButton(
        { evaluate } as never,
        input as never,
        undefined,
        ["first.md", "second.md"],
        300,
      );
      const assertion = expect(pending).resolves.toBe(true);

      await vi.advanceTimersByTimeAsync(1_500);
      await assertion;
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("only attachment sends get the longer send-button deadline", () => {
    expect(promptComposer.sendButtonTimeoutMs()).toBe(20_000);
    expect(promptComposer.sendButtonTimeoutMs([])).toBe(20_000);
    expect(promptComposer.sendButtonTimeoutMs(["oracle-attach-verify.txt"])).toBe(45_000);
    expect(promptComposer.sendButtonTimeoutMs(["oracle-attach-verify.txt"], 120_000)).toBe(120_000);
  });

  test("marks prompt dispatch before commit verification", async () => {
    const events: string[] = [];
    const onPromptDispatchStarted = vi.fn(() => {
      events.push("dispatch");
    });
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) {
          return { result: { value: { ready: true, composer: true, fileInput: false } } };
        }
        if (expression.includes("focused: true")) {
          return { result: { value: { focused: true } } };
        }
        if (expression.includes("editorText")) {
          return {
            result: { value: { editorText: "hello", fallbackValue: "", activeValue: "hello" } },
          };
        }
        if (expression.includes("button.scrollIntoView")) {
          return { result: { value: { status: "clicked" } } };
        }
        events.push("verify");
        return {
          result: {
            value: {
              baseline: 0,
              turnsCount: 1,
              matchedUserTurnIndex: 0,
              matchedUserTurnId: "turn-1",
              matchedUserMessageId: "message-1",
              matchedUserTurnText: "hello",
              hasNewTurn: true,
              stopVisible: true,
              assistantVisible: false,
              composerCleared: true,
              inConversation: true,
              conversationId: "conversation-1",
            },
          },
        };
      }),
    };
    const input = { insertText: vi.fn(), dispatchKeyEvent: vi.fn() };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await submitPrompt(
      {
        runtime: runtime as never,
        input: input as never,
        baselineTurns: 0,
        onPromptDispatchStarted,
      },
      "hello",
      logger as never,
    );

    expect(onPromptDispatchStarted).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["dispatch", "verify"]);
  });

  test("waits for a delayed trusted click without issuing a second send", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn().mockResolvedValue({
        result: { value: { status: "point", x: 10, y: 20 } },
      });
      const input = {
        dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
          if (type === "mouseReleased") {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }),
      };

      const result = promptComposer.attemptSendButton(
        { evaluate } as never,
        input as never,
        undefined,
        undefined,
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe(true);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
