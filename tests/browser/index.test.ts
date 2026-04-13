import { describe, expect, test } from "vitest";
import { __test__, shouldPreserveBrowserOnErrorForTest } from "../../src/browser/index.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

describe("shouldPreserveBrowserOnErrorForTest", () => {
  test("preserves the browser for headful cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
  });

  test("does not preserve the browser for headless cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, true)).toBe(false);
  });

  test("does not preserve the browser for unrelated browser errors", () => {
    const error = new BrowserAutomationError("other browser error", {
      stage: "execute-browser",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(false);
  });

  test("does not preserve the browser for backend Cloudflare API challenges", () => {
    const error = new BrowserAutomationError("backend challenge", {
      stage: "cloudflare-backend-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(false);
  });
});

describe("remote Chrome option warnings", () => {
  test("does not mark browser-chrome-path as ignored for attach-running", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: true,
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    ).not.toContain("--browser-chrome-path");
  });

  test("marks browser-chrome-path as ignored for classic remote-chrome", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: false,
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    ).toContain("--browser-chrome-path");
  });

  test("marks manual-login flags as ignored for classic remote-chrome", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: false,
        manualLogin: true,
        manualLoginProfileDir: "/tmp/oracle-profile",
      }),
    ).toEqual(
      expect.arrayContaining(["--browser-manual-login", "--browser-manual-login-profile-dir"]),
    );
  });
});

describe("assistant retry policy", () => {
  test("does not retry or classify empty assistant turns as timeouts", () => {
    const error = new Error("assistant-response-empty-turn");
    expect(__test__.shouldReloadAfterAssistantError(error)).toBe(false);
    expect(__test__.isAssistantResponseTimeoutError(error)).toBe(false);
  });

  test("still retries generic assistant timeouts", () => {
    const error = new Error("assistant-response-watchdog-timeout");
    expect(__test__.shouldReloadAfterAssistantError(error)).toBe(true);
    expect(__test__.isAssistantResponseTimeoutError(error)).toBe(true);
  });
});

describe("assistant DOM snapshot replacement", () => {
  test("replaces missing markdown capture with a fresher DOM snapshot", () => {
    expect(
      __test__.shouldReplaceAssistantCaptureWithDomSnapshot({
        promptText: "Summarize this diff",
        currentMarkdown: "short copied text",
        copiedMarkdown: null,
        finalText: "short copied text with the real ending attached",
      }),
    ).toBe(true);
  });

  test("does not replace copied markdown for a small DOM mismatch", () => {
    expect(
      __test__.shouldReplaceAssistantCaptureWithDomSnapshot({
        promptText: "Summarize this diff",
        currentMarkdown: "fully copied assistant answer",
        copiedMarkdown: "fully copied assistant answer",
        finalText: "fully copied assistant answer plus footer",
      }),
    ).toBe(false);
  });

  test("replaces heavily truncated copied markdown with a larger DOM snapshot", () => {
    expect(
      __test__.shouldReplaceAssistantCaptureWithDomSnapshot({
        promptText: "Summarize this diff",
        currentMarkdown: "tiny copy",
        copiedMarkdown: "tiny copy",
        finalText: "tiny copy with a much larger DOM-only continuation that proves truncation",
      }),
    ).toBe(true);
  });

  test("does not replace with prompt echo text", () => {
    expect(
      __test__.shouldReplaceAssistantCaptureWithDomSnapshot({
        promptText: "Summarize this diff",
        currentMarkdown: "assistant answer",
        copiedMarkdown: null,
        finalText: "Summarize this diff",
      }),
    ).toBe(false);
  });
});
