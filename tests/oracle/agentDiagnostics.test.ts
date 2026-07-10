import { describe, expect, test } from "vitest";
import { buildAgentBlockerFromSession } from "../../src/oracle/agentDiagnostics.ts";
import type { SessionMetadata } from "../../src/sessionStore.js";

function session(overrides: Partial<SessionMetadata>): SessionMetadata {
  return {
    id: "sess-1",
    createdAt: "2026-06-10T00:00:00.000Z",
    status: "error",
    cwd: "/tmp/oracle",
    mode: "browser",
    model: "gpt-5.6-sol-pro",
    options: { prompt: "review", file: [], model: "gpt-5.6-sol-pro", mode: "browser" },
    ...overrides,
  };
}

describe("buildAgentBlockerFromSession", () => {
  test("classifies assistant timeouts as resumable", () => {
    const blocker = buildAgentBlockerFromSession(
      session({
        errorMessage: "assistant timed out",
        response: { status: "incomplete", incompleteReason: "incomplete-capture" },
        error: {
          category: "browser-automation",
          message: "assistant timed out",
          details: { stage: "assistant-timeout" },
        },
      }),
    );

    expect(blocker).toMatchObject({
      kind: "timeout",
      severity: "retryable",
      resumable: true,
      resumeCommand: "oracle session sess-1",
      evidence: {
        sessionId: "sess-1",
        incompleteReason: "incomplete-capture",
        errorStage: "assistant-timeout",
      },
    });
  });

  test("classifies lost browser sessions as resumable browser unavailability", () => {
    const blocker = buildAgentBlockerFromSession(
      session({
        status: "running",
        errorMessage: "Chrome disconnected before completion",
        response: { status: "running", incompleteReason: "chrome-disconnected" },
        error: {
          category: "browser-automation",
          message: "Chrome disconnected",
          details: { stage: "connection-lost" },
        },
      }),
    );

    expect(blocker).toMatchObject({
      kind: "browser_unavailable",
      severity: "retryable",
      resumable: true,
      resumeCommand: "oracle session sess-1",
    });
  });

  test("classifies prompt acceptance failures as selector drift", () => {
    const blocker = buildAgentBlockerFromSession(
      session({
        errorMessage:
          "ChatGPT did not enter a visible thinking/running state after the prompt was submitted.",
        error: {
          category: "browser-automation",
          message:
            "ChatGPT did not enter a visible thinking/running state after the prompt was submitted.",
          details: {
            stage: "submit-prompt",
            code: "prompt-not-accepted",
          },
        },
      }),
    );

    expect(blocker).toMatchObject({
      kind: "selector_drift",
      severity: "action_required",
      resumable: false,
      evidence: {
        errorStage: "submit-prompt",
        errorCode: "prompt-not-accepted",
      },
    });
  });

  test("classifies project/thread redirects as scope mismatch with URL evidence", () => {
    const blocker = buildAgentBlockerFromSession(
      session({
        errorMessage:
          "ChatGPT did not stay on the requested project/thread URL; refusing to fall back to root chat.",
        error: {
          category: "browser-automation",
          message:
            "ChatGPT did not stay on the requested project/thread URL; refusing to fall back to root chat.",
          details: {
            stage: "chatgpt-scope",
            code: "scope-mismatch",
            expectedUrl: "https://chatgpt.com/g/g-p-test/project",
            actualUrl: "https://chatgpt.com/",
          },
        },
      }),
    );

    expect(blocker).toMatchObject({
      kind: "scope_mismatch",
      severity: "action_required",
      resumable: false,
      evidence: {
        errorStage: "chatgpt-scope",
        errorCode: "scope-mismatch",
        expectedUrl: "https://chatgpt.com/g/g-p-test/project",
        actualUrl: "https://chatgpt.com/",
      },
    });
  });

  test("preserves prompt acceptance signals and blockers in diagnostic evidence", () => {
    const blocker = buildAgentBlockerFromSession(
      session({
        errorMessage:
          "ChatGPT did not enter a visible thinking/running state after the prompt was submitted.",
        error: {
          category: "browser-automation",
          message:
            "ChatGPT did not enter a visible thinking/running state after the prompt was submitted.",
          details: {
            stage: "submit-prompt",
            code: "prompt-not-accepted",
            signals: ["composer-cleared-after-send"],
            blockers: ["permission-required"],
          },
        },
      }),
    );

    expect(blocker).toMatchObject({
      kind: "selector_drift",
      evidence: {
        errorSignals: ["composer-cleared-after-send"],
        errorBlockers: ["permission-required"],
      },
    });
  });

  test.each([
    {
      name: "login_required",
      meta: session({ errorMessage: "Please sign in to ChatGPT before continuing." }),
      logTail: "",
      kind: "login_required",
      severity: "action_required",
    },
    {
      name: "captcha",
      meta: session({
        errorMessage: "Cloudflare challenge detected.",
        error: {
          category: "browser-automation",
          message: "Cloudflare challenge detected.",
          details: { stage: "cloudflare-challenge" },
        },
      }),
      logTail: "",
      kind: "captcha",
      severity: "action_required",
    },
    {
      name: "permission",
      meta: session({ errorMessage: "403 forbidden: account does not have access." }),
      logTail: "",
      kind: "permission",
      severity: "action_required",
    },
    {
      name: "rate_limit",
      meta: session({ transport: { reason: "api-error" } }),
      logTail: "429 rate limit exceeded; retry after your quota resets.",
      kind: "rate_limit",
      severity: "retryable",
    },
    {
      name: "selector_drift",
      meta: session({
        errorMessage: "Unable to find prompt textarea selector [data-testid=prompt-textarea].",
      }),
      logTail: "",
      kind: "selector_drift",
      severity: "action_required",
    },
    {
      name: "model_unavailable",
      meta: session({ transport: { reason: "model-unavailable" } }),
      logTail: "",
      kind: "model_unavailable",
      severity: "action_required",
    },
    {
      name: "model_option_unavailable",
      meta: session({
        error: {
          category: "browser-automation",
          message: 'Unable to find model option matching "Thinking 5.5".',
          details: { stage: "model-selection", code: "model-option-unavailable" },
        },
      }),
      logTail: "",
      kind: "model_unavailable",
      severity: "action_required",
    },
    {
      name: "model_selector_missing",
      meta: session({
        error: {
          category: "browser-automation",
          message: "Unable to locate the ChatGPT model selector button.",
          details: { stage: "model-selection", code: "model-selector-missing" },
        },
      }),
      logTail: "",
      kind: "selector_drift",
      severity: "action_required",
    },
    {
      name: "unsupported_endpoint",
      meta: session({ transport: { reason: "unsupported-endpoint" } }),
      logTail: "",
      kind: "unsupported_endpoint",
      severity: "action_required",
    },
  ])("classifies $name blockers", ({ meta, logTail, kind, severity }) => {
    const blocker = buildAgentBlockerFromSession(meta, { logTail });

    expect(blocker).toMatchObject({
      kind,
      severity,
      resumable: false,
    });
  });

  test("returns unknown for unclassified failed sessions", () => {
    const blocker = buildAgentBlockerFromSession(session({ errorMessage: "unexpected failure" }));

    expect(blocker).toMatchObject({
      kind: "unknown",
      severity: "unknown",
      resumable: false,
      message: "unexpected failure",
    });
  });

  test("returns undefined for completed sessions without failure metadata", () => {
    const blocker = buildAgentBlockerFromSession(
      session({
        status: "completed",
        errorMessage: undefined,
        error: undefined,
        response: { status: "completed" },
      }),
    );

    expect(blocker).toBeUndefined();
  });
});
